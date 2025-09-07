#!/usr/bin/env ts-node

import { Command } from 'commander';
import { logger } from '../../services/LoggerService.js';
import CdnFile from '../../models/cdn/CdnFile.js';
import { hybridStorageManager, StorageType } from '../services/hybridStorageManager.js';
import { storageManager } from '../services/storageManager.js';
import { spacesStorage } from '../services/spacesStorage.js';
import { processZipFile } from '../services/zipProcessor.js';
import sequelize from '../../config/db.js';
import { Transaction, Op } from 'sequelize';
import { safeTransactionRollback } from '../../utils/Utility.js';
import fs from 'fs';
import path from 'path';

/**
 * Migration script to add storage type information to existing CDN file entries
 * This ensures that all files have proper storage type metadata for fallback logic
 */

/**
 * Clean up old CDN folders referenced in metadata after successful migration
 * Only removes folders that are no longer needed after migration
 */
async function cleanupOldCdnFolders(metadata: any, fileId: string): Promise<void> {
    try {
        const foldersToCleanup: string[] = [];
        
        // Extract old folder paths from metadata
        if (metadata.originalZip?.path) {
            const oldZipDir = path.dirname(metadata.originalZip.path);
            foldersToCleanup.push(oldZipDir);
        }
        
        // Extract old level file paths
        if (metadata.levelFiles) {
            Object.values(metadata.levelFiles).forEach((levelFile: any) => {
                if (levelFile.path) {
                    const oldLevelDir = path.dirname(levelFile.path);
                    if (!foldersToCleanup.includes(oldLevelDir)) {
                        foldersToCleanup.push(oldLevelDir);
                    }
                }
            });
        }
        
        // Extract old song file paths
        if (metadata.songFiles) {
            Object.values(metadata.songFiles).forEach((songFile: any) => {
                if (songFile.path) {
                    const oldSongDir = path.dirname(songFile.path);
                    if (!foldersToCleanup.includes(oldSongDir)) {
                        foldersToCleanup.push(oldSongDir);
                    }
                }
            });
        }
        
        // Clean up each old folder
        for (const folderPath of foldersToCleanup) {
            try {
                if (fs.existsSync(folderPath)) {
                    // Check if folder is empty or only contains old files
                    const files = await fs.promises.readdir(folderPath);
                    if (files.length === 0) {
                        await fs.promises.rmdir(folderPath);
                        logger.info('Cleaned up empty old CDN folder:', {
                            fileId,
                            folderPath
                        });
                    } else {
                        // Check if all files in the folder are old (not referenced in new metadata)
                        const newCdnFile = await CdnFile.findByPk(fileId);
                        if (newCdnFile) {
                            const newMetadata = newCdnFile.metadata as any;
                            const newPaths = new Set<string>();
                            
                            // Collect all new file paths
                            if (newMetadata.originalZip?.path) {
                                newPaths.add(newMetadata.originalZip.path);
                            }
                            if (newMetadata.levelFiles) {
                                Object.values(newMetadata.levelFiles).forEach((file: any) => {
                                    if (file.path) newPaths.add(file.path);
                                });
                            }
                            if (newMetadata.songFiles) {
                                Object.values(newMetadata.songFiles).forEach((file: any) => {
                                    if (file.path) newPaths.add(file.path);
                                });
                            }
                            
                            // Check if all files in the old folder are not in new paths
                            const allFilesOld = files.every(file => {
                                const fullPath = path.join(folderPath, file);
                                return !newPaths.has(fullPath);
                            });
                            
                            if (allFilesOld) {
                                await fs.promises.rm(folderPath, { recursive: true, force: true });
                                logger.info('Cleaned up old CDN folder with obsolete files:', {
                                    fileId,
                                    folderPath,
                                    filesRemoved: files.length
                                });
                            } else {
                                logger.info('Skipped cleanup of old CDN folder (contains files still in use):', {
                                    fileId,
                                    folderPath,
                                    filesInFolder: files.length
                                });
                            }
                        }
                    }
                }
            } catch (error) {
                logger.warn('Failed to clean up old CDN folder:', {
                    fileId,
                    folderPath,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }
        
    } catch (error) {
        logger.error('Error during old CDN folder cleanup:', {
            fileId,
            error: error instanceof Error ? error.message : String(error)
        });
        // Don't throw - cleanup failure shouldn't fail the migration
    }
}

/**
 * Migrate to hybrid storage strategy: zip files in Spaces, transformation files locally
 * This function re-processes existing files to optimize for transformation performance
 */
export async function migrateToHybridStrategy(batchSize?: number): Promise<void> {
    let transaction: Transaction | undefined;
    
    try {
        logger.info('Starting migration to hybrid storage strategy (zips in Spaces, transformation files local)', {
            batchSize: batchSize || 'all'
        });
        
        // Start transaction
        transaction = await sequelize.transaction();
        
        // Get all zip files that need hybrid migration
        const whereClause: any = {
            type: 'LEVELZIP'
        };
        
        const queryOptions: any = {
            where: whereClause,
            transaction
        };
        
        if (batchSize && batchSize > 0) {
            queryOptions.limit = batchSize;
            queryOptions.order = [['createdAt', 'ASC']]; // Process oldest files first
        }
        
        const filesToMigrate = await CdnFile.findAll(queryOptions);
        
        logger.info(`Found ${filesToMigrate.length} zip files to migrate to hybrid strategy`);
        
        let migratedCount = 0;
        let errorCount = 0;
        const migrationResults: Array<{
            fileId: string;
            success: boolean;
            error?: string;
            tempPath?: string;
        }> = [];
        
        // Get the first available drive for temporary storage
        const drives = storageManager.getDrivesStatus();
        const primaryDrive = drives[0]?.drivePath;
        
        if (!primaryDrive) {
            throw new Error('No available drives for temporary storage');
        }
        
        logger.info(`Using primary drive for temporary storage: ${primaryDrive}`);
        
        for (const file of filesToMigrate) {
            let tempPath: string | undefined;
            let originalZip: any;
            
            try {
                logger.info('Starting migration for file:', {
                    fileId: file.id,
                    type: file.type,
                    currentFilePath: file.filePath
                });
                
                const metadata = file.metadata as any || {};
                originalZip = metadata.originalZip;
                
                if (!originalZip?.path) {
                    throw new Error('No original zip path found in metadata');
                }
                
                logger.info('Found original zip metadata:', {
                    fileId: file.id,
                    originalZipPath: originalZip.path,
                    originalZipName: originalZip.name,
                    originalZipSize: originalZip.size,
                    originalZipStorageType: originalZip.storageType
                });
                
                // Check if file exists and get its current location
                const fileCheck = await hybridStorageManager.fileExistsWithFallback(
                    originalZip.path,
                    originalZip.storageType
                );
                
                if (!fileCheck.exists) {
                    logger.warn('Original zip file not found, skipping:', {
                        fileId: file.id,
                        filePath: originalZip.path,
                        expectedStorageType: originalZip.storageType,
                        foundStorageType: fileCheck.storageType
                    });
                    continue;
                }
                
                logger.info('File location confirmed:', {
                    fileId: file.id,
                    originalPath: originalZip.path,
                    storageType: fileCheck.storageType,
                    exists: fileCheck.exists
                });
                
                // Create temporary directory on primary drive
                const tempDir = path.join(primaryDrive, 'temp', 'hybrid-migration', file.id);
                await fs.promises.mkdir(tempDir, { recursive: true });
                
                // Download zip file to temporary location if it's in Spaces
                let zipSourcePath: string;
                if (fileCheck.storageType === StorageType.SPACES) {
                    // Download from Spaces to temp
                    tempPath = path.join(tempDir, path.basename(originalZip.path));
                    await spacesStorage.downloadFile(originalZip.path, tempPath);
                    zipSourcePath = tempPath;
                    
                    logger.info('Downloaded zip from Spaces to temporary location:', {
                        fileId: file.id,
                        spacesPath: originalZip.path,
                        tempPath
                    });
                } else {
                    // File is already local, copy to temp
                    // Check if originalZip.path is already absolute or relative
                    const originalPath = path.isAbsolute(originalZip.path) 
                        ? originalZip.path 
                        : path.join(await storageManager.getDrive(), originalZip.path);
                    
                    // Check if the file actually exists before trying to copy
                    if (!fs.existsSync(originalPath)) {
                        throw new Error(`Local file not found: ${originalPath}`);
                    }
                    
                    tempPath = path.join(tempDir, path.basename(originalZip.path));
                    await fs.promises.copyFile(originalPath, tempPath);
                    zipSourcePath = tempPath;
                    
                    logger.info('Copied local zip to temporary location:', {
                        fileId: file.id,
                        originalPath,
                        tempPath,
                        isAbsolute: path.isAbsolute(originalZip.path),
                        fileExists: fs.existsSync(originalPath)
                    });
                }
                
                // Delete original files using standard deletion function
                await hybridStorageManager.deleteLevelZipFiles(file.id, metadata);
                
                logger.info('Deleted original files:', {
                    fileId: file.id
                });
                
                // Delete the database record so we can recreate it
                await file.destroy({ transaction });
                
                logger.info('Deleted database record:', {
                    fileId: file.id
                });
                
                // Commit the transaction before calling processZipFile
                // to avoid nested transaction issues
                if (transaction) {
                    await transaction.commit();
                    transaction = undefined; // Clear the transaction reference
                }
                
                // Re-process through standard procedure with hybrid strategy
                // The zipProcessor will use the current hybrid storage configuration
                // Use the original filename from the zip file itself, not from metadata
                const originalFilename = path.basename(zipSourcePath);
                await processZipFile(
                    zipSourcePath,
                    file.id, // Use existing fileId to maintain consistency
                    originalFilename
                );
                
                // Clean up old CDN folders from metadata paths after successful migration
                await cleanupOldCdnFolders(metadata, file.id);
                
                // Start a new transaction for the next iteration
                transaction = await sequelize.transaction();
                
                // Clean up temporary file
                if (tempPath && fs.existsSync(tempPath)) {
                    await fs.promises.unlink(tempPath);
                    await fs.promises.rmdir(path.dirname(tempPath));
                }
                
                migratedCount++;
                migrationResults.push({
                    fileId: file.id,
                    success: true
                });
                
                logger.info('Successfully migrated to hybrid strategy:', {
                    fileId: file.id,
                    originalPath: originalZip.path
                });
                
                if (migratedCount % 5 === 0) {
                    logger.info(`Hybrid migration progress: ${migratedCount}/${filesToMigrate.length} files processed`);
                }
                
            } catch (error) {
                errorCount++;
                const errorMessage = error instanceof Error ? error.message : String(error);
                
                // Enhanced error logging for validation errors
                if (error instanceof Error && error.message === 'Validation error') {
                    logger.error('Database validation error details:', {
                        fileId: file.id,
                        error: errorMessage,
                        stack: error.stack,
                        originalZipPath: originalZip?.path,
                        originalZipName: originalZip?.name
                    });
                }
                
                // Clean up temporary file if it exists
                if (tempPath && fs.existsSync(tempPath)) {
                    try {
                        await fs.promises.unlink(tempPath);
                        const tempDir = path.dirname(tempPath);
                        if (fs.existsSync(tempDir)) {
                            await fs.promises.rmdir(tempDir);
                        }
                    } catch (cleanupError) {
                        logger.warn('Failed to clean up temporary file:', {
                            tempPath,
                            error: cleanupError
                        });
                    }
                }
                
                migrationResults.push({
                    fileId: file.id,
                    success: false,
                    error: errorMessage,
                    tempPath
                });
                
                logger.error('Error migrating to hybrid strategy:', {
                    fileId: file.id,
                    error: errorMessage,
                    stack: error instanceof Error ? error.stack : undefined
                });
            }
        }
        
        // Commit transaction if it exists
        if (transaction) {
            await transaction.commit();
        }
        
        // Log detailed results
        const successRate = filesToMigrate.length > 0 ? ((migratedCount / filesToMigrate.length) * 100).toFixed(2) : '0';
        
        logger.info('Hybrid strategy migration completed:', {
            totalFiles: filesToMigrate.length,
            migratedCount,
            errorCount,
            successRate: `${successRate}%`,
            primaryDrive,
            batchSize: batchSize || 'unlimited'
        });
        
        // Log failed migrations for debugging
        const failedMigrations = migrationResults.filter(r => !r.success);
        if (failedMigrations.length > 0) {
            logger.warn('Failed hybrid migrations summary:', {
                failedCount: failedMigrations.length,
                failedFileIds: failedMigrations.map(f => f.fileId),
                sampleErrors: failedMigrations.slice(0, 5).map(f => ({
                    fileId: f.fileId,
                    error: f.error
                }))
            });
        }
        
    } catch (error) {
        // Rollback transaction if it exists
        if (transaction) {
            try {
                await safeTransactionRollback(transaction);
            } catch (rollbackError) {
                logger.warn('Transaction rollback failed:', rollbackError);
            }
        }
        
        logger.error('Hybrid strategy migration failed:', {
            error: error instanceof Error ? error.message : String(error)
        });
        throw error;
    }
}

/**
 * Migrate local zip files to DigitalOcean Spaces
 * This function copies local files to temp, deletes originals, then re-uploads to Spaces
 */
export async function migrateLocalZipsToSpaces(batchSize?: number): Promise<void> {
    let transaction: Transaction | undefined;
    
    try {
        logger.info('Starting migration of local zip files to DigitalOcean Spaces', {
            batchSize: batchSize || 'all'
        });
        
        // Start transaction
        transaction = await sequelize.transaction();
        
        // Get local zip files that need migration
        const whereClause: any = {
            type: 'LEVELZIP',
            [Op.or]: [
                { metadata: null },
                { metadata: { storageType: StorageType.LOCAL } },
                { metadata: { storageType: null } }
            ]
        };
        
        const queryOptions: any = {
            where: whereClause,
            transaction
        };
        
        if (batchSize && batchSize > 0) {
            queryOptions.limit = batchSize;
            queryOptions.order = [['createdAt', 'ASC']]; // Process oldest files first
        }
        
        const filesToMigrate = await CdnFile.findAll(queryOptions);
        
        logger.info(`Found ${filesToMigrate.length} local zip files to migrate to Spaces`);
        
        let migratedCount = 0;
        let errorCount = 0;
        const migrationResults: Array<{
            fileId: string;
            success: boolean;
            error?: string;
            tempPath?: string;
        }> = [];
        
        // Get the first available drive for temporary storage
        const drives = storageManager.getDrivesStatus();
        const primaryDrive = drives[0]?.drivePath; // Use first available drive
        
        if (!primaryDrive) {
            throw new Error('No available drives for temporary storage');
        }
        
        logger.info(`Using primary drive for temporary storage: ${primaryDrive}`);
        
        for (const file of filesToMigrate) {
            let tempPath: string | undefined;
            
            try {
                const metadata = file.metadata as any || {};
                const originalZip = metadata.originalZip;
                
                if (!originalZip?.path) {
                    throw new Error('No original zip path found in metadata');
                }
                
                // Check if file exists locally
                const fileCheck = await hybridStorageManager.fileExistsWithFallback(
                    originalZip.path,
                    StorageType.LOCAL
                );
                
                if (!fileCheck.exists) {
                    logger.warn('Local zip file not found, skipping:', {
                        fileId: file.id,
                        filePath: originalZip.path
                    });
                    continue;
                }
                
                // Create temporary directory on primary drive
                const tempDir = path.join(primaryDrive, 'temp', 'migration', file.id);
                await fs.promises.mkdir(tempDir, { recursive: true });
                
                // Copy file to temporary location
                const originalPath = path.join(await storageManager.getDrive(), originalZip.path);
                tempPath = path.join(tempDir, path.basename(originalZip.path));
                
                await fs.promises.copyFile(originalPath, tempPath);
                
                logger.info('Copied file to temporary location:', {
                    fileId: file.id,
                    originalPath,
                    tempPath
                });
                
                // Delete original file using standard deletion function
                await hybridStorageManager.deleteLevelZipFiles(file.id, metadata);
                
                logger.info('Deleted original local files:', {
                    fileId: file.id
                });
                
                // Re-upload through standard procedure (as if it just arrived)
                await processZipFile(
                    tempPath,
                    file.id, // Use existing fileId
                    path.basename(originalZip.path)
                );
                
                // Clean up temporary file
                await fs.promises.unlink(tempPath);
                await fs.promises.rmdir(path.dirname(tempPath));
                
                migratedCount++;
                migrationResults.push({
                    fileId: file.id,
                    success: true
                });
                
                logger.info('Successfully migrated zip to Spaces:', {
                    fileId: file.id,
                    originalPath: originalZip.path
                });
                
                if (migratedCount % 5 === 0) {
                    logger.info(`Migration progress: ${migratedCount}/${filesToMigrate.length} files processed`);
                }
                
            } catch (error) {
                errorCount++;
                const errorMessage = error instanceof Error ? error.message : String(error);
                
                // Clean up temporary file if it exists
                if (tempPath && fs.existsSync(tempPath)) {
                    try {
                        await fs.promises.unlink(tempPath);
                        const tempDir = path.dirname(tempPath);
                        if (fs.existsSync(tempDir)) {
                            await fs.promises.rmdir(tempDir);
                        }
                    } catch (cleanupError) {
                        logger.warn('Failed to clean up temporary file:', {
                            tempPath,
                            error: cleanupError
                        });
                    }
                }
                
                migrationResults.push({
                    fileId: file.id,
                    success: false,
                    error: errorMessage,
                    tempPath
                });
                
                logger.error('Error migrating zip file:', {
                    fileId: file.id,
                    error: errorMessage
                });
            }
        }
        
        // Commit transaction
        await transaction.commit();
        
        // Log detailed results
        const successRate = filesToMigrate.length > 0 ? ((migratedCount / filesToMigrate.length) * 100).toFixed(2) : '0';
        
        logger.info('Local zip migration to Spaces completed:', {
            totalFiles: filesToMigrate.length,
            migratedCount,
            errorCount,
            successRate: `${successRate}%`,
            primaryDrive,
            batchSize: batchSize || 'unlimited'
        });
        
        // Log failed migrations for debugging
        const failedMigrations = migrationResults.filter(r => !r.success);
        if (failedMigrations.length > 0) {
            logger.warn('Failed migrations summary:', {
                failedCount: failedMigrations.length,
                failedFileIds: failedMigrations.map(f => f.fileId),
                sampleErrors: failedMigrations.slice(0, 5).map(f => ({
                    fileId: f.fileId,
                    error: f.error
                }))
            });
        }
        
    } catch (error) {
        // Rollback transaction if it exists
        if (transaction) {
            try {
                await safeTransactionRollback(transaction);
            } catch (rollbackError) {
                logger.warn('Transaction rollback failed:', rollbackError);
            }
        }
        
        logger.error('Local zip migration to Spaces failed:', {
            error: error instanceof Error ? error.message : String(error)
        });
        throw error;
    }
}
export async function migrateStorageTypes(batchSize?: number, fileType?: string): Promise<void> {
    let transaction: Transaction | undefined;
    
    try {
        logger.info('Starting storage type migration for existing CDN files', {
            batchSize: batchSize || 'all',
            fileType: fileType || 'all'
        });
        
        // Start transaction
        transaction = await sequelize.transaction();
        
        // Build where clause for files that don't have storage type information
        const whereClause: any = {
            [Op.or]: [
                { metadata: null },
                { metadata: { storageType: null } },
                { metadata: { [Op.not]: { storageType: { [Op.ne]: null } } } }
            ]
        };
        
        // Add file type filter if specified
        if (fileType) {
            whereClause.type = fileType;
        }
        
        // Get CDN files that need migration
        const queryOptions: any = {
            where: whereClause,
            transaction
        };
        
        // Add limit if batch size is specified
        if (batchSize && batchSize > 0) {
            queryOptions.limit = batchSize;
            queryOptions.order = [['createdAt', 'ASC']]; // Process oldest files first
        }
        
        const filesToMigrate = await CdnFile.findAll(queryOptions);
        
        logger.info(`Found ${filesToMigrate.length} files to migrate`, {
            batchSize: batchSize || 'unlimited',
            fileType: fileType || 'all',
            totalInBatch: filesToMigrate.length
        });
        
        let migratedCount = 0;
        let errorCount = 0;
        const migrationResults: Array<{
            fileId: string;
            success: boolean;
            storageType?: StorageType;
            error?: string;
        }> = [];
        
        for (const file of filesToMigrate) {
            try {
                const metadata = file.metadata as any || {}; // Handle null metadata
                let storageType = StorageType.LOCAL; // Default to local
                
                // Try to determine storage type by checking file existence
                const fileCheck = await hybridStorageManager.fileExistsWithFallback(
                    file.filePath,
                    undefined // No preferred storage type
                );
                
                if (fileCheck.exists) {
                    storageType = fileCheck.storageType;
                } else {
                    // If file doesn't exist anywhere, default to local
                    logger.warn('File not found in any storage, defaulting to local:', {
                        fileId: file.id,
                        filePath: file.filePath,
                        type: file.type
                    });
                }
                
                // Update metadata with storage type information
                const updatedMetadata = {
                    ...metadata,
                    storageType,
                    migratedAt: new Date().toISOString(),
                    migrationVersion: '1.0'
                };
                
                // For level zip files, also update nested storage types
                if (file.type === 'LEVELZIP') {
                    updatedMetadata.levelStorageType = storageType;
                    updatedMetadata.songStorageType = storageType;
                    
                    if (updatedMetadata.originalZip) {
                        updatedMetadata.originalZip.storageType = storageType;
                    }
                    
                    // Add comprehensive storage info
                    updatedMetadata.storageInfo = {
                        primary: storageType,
                        levels: storageType,
                        songs: storageType,
                        zip: storageType
                    };
                }
                
                await file.update({
                    metadata: updatedMetadata
                }, { transaction });
                
                migratedCount++;
                migrationResults.push({
                    fileId: file.id,
                    success: true,
                    storageType
                });
                
                if (migratedCount % 10 === 0) {
                    logger.info(`Migration progress: ${migratedCount}/${filesToMigrate.length} files processed`);
                }
                
            } catch (error) {
                errorCount++;
                const errorMessage = error instanceof Error ? error.message : String(error);
                
                migrationResults.push({
                    fileId: file.id,
                    success: false,
                    error: errorMessage
                });
                
                logger.error('Error migrating file:', {
                    fileId: file.id,
                    error: errorMessage
                });
            }
        }
        
        // Commit transaction
        await transaction.commit();
        
        // Log detailed results
        const successRate = filesToMigrate.length > 0 ? ((migratedCount / filesToMigrate.length) * 100).toFixed(2) : '0';
        const storageTypeBreakdown = migrationResults
            .filter(r => r.success && r.storageType)
            .reduce((acc, r) => {
                acc[r.storageType!] = (acc[r.storageType!] || 0) + 1;
                return acc;
            }, {} as Record<string, number>);
        
        logger.info('Storage type migration completed:', {
            totalFiles: filesToMigrate.length,
            migratedCount,
            errorCount,
            successRate: `${successRate}%`,
            storageTypeBreakdown,
            batchSize: batchSize || 'unlimited',
            fileType: fileType || 'all'
        });
        
        // Log failed migrations for debugging
        const failedMigrations = migrationResults.filter(r => !r.success);
        if (failedMigrations.length > 0) {
            logger.warn('Failed migrations summary:', {
                failedCount: failedMigrations.length,
                failedFileIds: failedMigrations.map(f => f.fileId),
                sampleErrors: failedMigrations.slice(0, 5).map(f => ({
                    fileId: f.fileId,
                    error: f.error
                }))
            });
        }
        
    } catch (error) {
        // Rollback transaction if it exists
        if (transaction) {
            try {
                await safeTransactionRollback(transaction);
            } catch (rollbackError) {
                logger.warn('Transaction rollback failed:', rollbackError);
            }
        }
        
        logger.error('Storage type migration failed:', {
            error: error instanceof Error ? error.message : String(error)
        });
        throw error;
    }
}

/**
 * Verify migration results by checking a sample of files
 */
export async function verifyMigration(): Promise<void> {
    try {
        logger.info('Verifying storage type migration results');
        
        const sampleFiles = await CdnFile.findAll({
            limit: 10,
            order: [['updatedAt', 'DESC']]
        });
        
        let verifiedCount = 0;
        let issuesFound = 0;
        
        for (const file of sampleFiles) {
            const metadata = file.metadata as any;
            
            // Default to local storage if metadata is null or storageType is not defined
            const storageType = metadata?.storageType || StorageType.LOCAL;
            
            if (metadata?.storageType) {
                verifiedCount++;
                
                // Test file access with fallback logic
                const fileCheck = await hybridStorageManager.fileExistsWithFallback(
                    file.filePath,
                    storageType
                );
                
                if (!fileCheck.exists) {
                    issuesFound++;
                    logger.warn('File not accessible after migration:', {
                        fileId: file.id,
                        filePath: file.filePath,
                        expectedStorageType: storageType,
                        foundStorageType: fileCheck.storageType
                    });
                }
            } else {
                // File doesn't have storage type defined, this is expected for unmigrated files
                logger.info('File without storage type (needs migration):', {
                    fileId: file.id,
                    filePath: file.filePath,
                    type: file.type,
                    defaultingTo: StorageType.LOCAL
                });
            }
        }
        
        logger.info('Migration verification completed:', {
            sampleSize: sampleFiles.length,
            verifiedCount,
            issuesFound,
            verificationRate: `${((verifiedCount / sampleFiles.length) * 100).toFixed(2)}%`
        });
        
    } catch (error) {
        logger.error('Migration verification failed:', {
            error: error instanceof Error ? error.message : String(error)
        });
        throw error;
    }
}

/**
 * Get drive usage statistics to monitor migration progress
 */
export async function getDriveUsageStats(): Promise<{
    drives: Array<{
        drive: string;
        totalSpace: string;
        usedSpace: string;
        availableSpace: string;
        usagePercentage: string;
        fileCount: number;
    }>;
    totalFiles: number;
    filesInSpaces: number;
    filesLocal: number;
}> {
    try {
        logger.info('Getting drive usage statistics');
        
        const drives = storageManager.getDrivesStatus();
        const driveStats = [];
        
        for (const drive of drives) {
            try {
                const fileCount = await getFileCountOnDrive(drive.drivePath);
                
                driveStats.push({
                    drive: drive.drivePath,
                    totalSpace: `${Math.round(drive.totalSpace / (1024**3))} GB`,
                    usedSpace: `${Math.round(drive.usedSpace / (1024**3))} GB`,
                    availableSpace: `${Math.round(drive.availableSpace / (1024**3))} GB`,
                    usagePercentage: `${drive.usagePercentage}%`,
                    fileCount
                });
            } catch (error) {
                logger.warn(`Failed to get stats for drive ${drive.drivePath}:`, error);
                driveStats.push({
                    drive: drive.drivePath,
                    totalSpace: 'Unknown',
                    usedSpace: 'Unknown',
                    availableSpace: 'Unknown',
                    usagePercentage: 'Unknown',
                    fileCount: 0
                });
            }
        }
        
        // Get file distribution stats
        const totalFiles = await CdnFile.count({ where: { type: 'LEVELZIP' } });
        const filesInSpaces = await CdnFile.count({
            where: {
                type: 'LEVELZIP',
                metadata: { storageType: StorageType.SPACES }
            }
        });
        const filesLocal = totalFiles - filesInSpaces;
        
        const result = {
            drives: driveStats,
            totalFiles,
            filesInSpaces,
            filesLocal
        };
        
        logger.info('Drive usage statistics:', result);
        return result;
        
    } catch (error) {
        logger.error('Failed to get drive usage statistics:', {
            error: error instanceof Error ? error.message : String(error)
        });
        throw error;
    }
}

/**
 * Helper function to count files on a specific drive
 */
async function getFileCountOnDrive(drive: string): Promise<number> {
    try {
        const cdnRoot = path.join(drive, 'tuf-cdn');
        if (!fs.existsSync(cdnRoot)) {
            return 0;
        }
        
        let fileCount = 0;
        const levelsDir = path.join(cdnRoot, 'levels');
        
            if (fs.existsSync(levelsDir)) {
                const entries = await fs.promises.readdir(levelsDir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        const subDir = path.join(levelsDir, entry.name);
                        const subEntries = await fs.promises.readdir(subDir, { withFileTypes: true });
                        fileCount += subEntries.filter(e => e.isFile()).length;
                    }
                }
            }
        
        return fileCount;
    } catch (error) {
        logger.warn(`Failed to count files on drive ${drive}:`, error);
        return 0;
    }
}

/**
 * Migrate local song files to DigitalOcean Spaces
 * This function moves song files from local storage to Spaces for better performance
 */
export async function migrateLocalSongFiles(batchSize?: number): Promise<void> {
    let transaction: Transaction | undefined;
    
    try {
        logger.info('Starting migration of local song files to DigitalOcean Spaces', {
            batchSize: batchSize || 'all'
        });
        
        // Start transaction
        transaction = await sequelize.transaction();
        
        // Get level zip files that have local song files
        const whereClause: any = {
            type: 'LEVELZIP',
            metadata: {
                songStorageType: StorageType.LOCAL
            }
        };
        
        const queryOptions: any = {
            where: whereClause,
            transaction
        };
        
        if (batchSize && batchSize > 0) {
            queryOptions.limit = batchSize;
            queryOptions.order = [['createdAt', 'ASC']]; // Process oldest files first
        }
        
        const filesToMigrate = await CdnFile.findAll(queryOptions);
        
        logger.info(`Found ${filesToMigrate.length} files with local song files to migrate to Spaces`);
        
        let migratedCount = 0;
        let errorCount = 0;
        const migrationResults: Array<{
            fileId: string;
            success: boolean;
            error?: string;
            songsMigrated?: number;
        }> = [];
        
        for (const file of filesToMigrate) {
            try {
                const metadata = file.metadata as any || {};
                const songFiles = metadata.songFiles || {};
                
                if (!songFiles || Object.keys(songFiles).length === 0) {
                    logger.info('No song files found, skipping:', {
                        fileId: file.id
                    });
                    continue;
                }
                
                logger.info('Starting song file migration for:', {
                    fileId: file.id,
                    songCount: Object.keys(songFiles).length
                });
                
                let songsMigrated = 0;
                const updatedSongFiles = { ...songFiles };
                
                // Migrate each song file to Spaces
                for (const [songKey, songFile] of Object.entries(songFiles)) {
                    try {
                        const songFileData = songFile as any;
                        if (!songFileData.path) {
                            logger.warn('Song file missing path, skipping:', {
                                fileId: file.id,
                                songKey
                            });
                            continue;
                        }
                        
                        // Check if song file exists locally
                        const localPath = path.join(await storageManager.getDrive(), songFileData.path);
                        if (!fs.existsSync(localPath)) {
                            logger.warn('Local song file not found, skipping:', {
                                fileId: file.id,
                                songKey,
                                localPath
                            });
                            continue;
                        }
                        
                        // Upload to Spaces
                        const spacesPath = `songs/${file.id}/${path.basename(songFileData.path)}`;
                        await spacesStorage.uploadFile(localPath, spacesPath);
                        
                        // Update metadata
                        updatedSongFiles[songKey] = {
                            ...songFileData,
                            path: spacesPath,
                            localPath: localPath, // Keep original local path for reference
                            storageType: StorageType.SPACES,
                            migratedAt: new Date().toISOString()
                        };
                        
                        // Delete local file
                        await fs.promises.unlink(localPath);
                        
                        songsMigrated++;
                        
                        logger.info('Migrated song file to Spaces:', {
                            fileId: file.id,
                            songKey,
                            localPath,
                            spacesPath
                        });
                        
                    } catch (error) {
                        logger.error('Failed to migrate individual song file:', {
                            fileId: file.id,
                            songKey,
                            error: error instanceof Error ? error.message : String(error)
                        });
                    }
                }
                
                // Update metadata with new song file locations
                const updatedMetadata = {
                    ...metadata,
                    songFiles: updatedSongFiles,
                    songStorageType: StorageType.SPACES,
                    songMigrationAt: new Date().toISOString()
                };
                
                await file.update({
                    metadata: updatedMetadata
                }, { transaction });
                
                migratedCount++;
                migrationResults.push({
                    fileId: file.id,
                    success: true,
                    songsMigrated
                });
                
                logger.info('Successfully migrated song files to Spaces:', {
                    fileId: file.id,
                    songsMigrated,
                    totalSongs: Object.keys(songFiles).length
                });
                
                if (migratedCount % 5 === 0) {
                    logger.info(`Song migration progress: ${migratedCount}/${filesToMigrate.length} files processed`);
                }
                
            } catch (error) {
                errorCount++;
                const errorMessage = error instanceof Error ? error.message : String(error);
                
                migrationResults.push({
                    fileId: file.id,
                    success: false,
                    error: errorMessage
                });
                
                logger.error('Error migrating song files:', {
                    fileId: file.id,
                    error: errorMessage
                });
            }
        }
        
        // Commit transaction
        await transaction.commit();
        
        // Log detailed results
        const successRate = filesToMigrate.length > 0 ? ((migratedCount / filesToMigrate.length) * 100).toFixed(2) : '0';
        const totalSongsMigrated = migrationResults
            .filter(r => r.success)
            .reduce((sum, r) => sum + (r.songsMigrated || 0), 0);
        
        logger.info('Local song file migration to Spaces completed:', {
            totalFiles: filesToMigrate.length,
            migratedCount,
            errorCount,
            successRate: `${successRate}%`,
            totalSongsMigrated,
            batchSize: batchSize || 'unlimited'
        });
        
        // Log failed migrations for debugging
        const failedMigrations = migrationResults.filter(r => !r.success);
        if (failedMigrations.length > 0) {
            logger.warn('Failed song migrations summary:', {
                failedCount: failedMigrations.length,
                failedFileIds: failedMigrations.map(f => f.fileId),
                sampleErrors: failedMigrations.slice(0, 5).map(f => ({
                    fileId: f.fileId,
                    error: f.error
                }))
            });
        }
        
    } catch (error) {
        // Rollback transaction if it exists
        if (transaction) {
            try {
                await safeTransactionRollback(transaction);
            } catch (rollbackError) {
                logger.warn('Transaction rollback failed:', rollbackError);
            }
        }
        
        logger.error('Local song file migration to Spaces failed:', {
            error: error instanceof Error ? error.message : String(error)
        });
        throw error;
    }
}

/**
 * Detect which drive contains a given path by checking against STORAGE_DRIVES
 */
function detectCurrentDrive(filePath: string): string | null {
    const storageDrivesEnv = process.env.STORAGE_DRIVES;
    if (!storageDrivesEnv) {
        throw new Error('STORAGE_DRIVES environment variable not set');
    }
    
    const storageDrives = storageDrivesEnv.split(',').map(drive => drive.trim());
    
    // Normalize the file path for comparison
    const normalizedFilePath = filePath.replace(/\\/g, '/');
    
    for (const drive of storageDrives) {
        // Normalize the drive path for comparison
        const normalizedDrive = drive.replace(/\\/g, '/');
        
        // Check if the file path contains this drive
        if (normalizedFilePath.includes(normalizedDrive)) {
            return drive; // Return the original drive path format
        }
        
        // Also check if the drive is just a letter (like "D:") and the path starts with it
        if (drive.length === 2 && drive.endsWith(':') && filePath.toUpperCase().startsWith(drive.toUpperCase())) {
            return drive;
        }
    }
    
    return null;
}

/**
 * Find the UUID-based folder path from a file path
 * Example: "/mnt/volume_sgp1_03/levels/da49583f-9617-4faa-bd42-bc574c96037c/main.adofai" 
 * Returns: "/mnt/volume_sgp1_03/levels/da49583f-9617-4faa-bd42-bc574c96037c"
 * Example: "D:\\tuf-cdn\\levels\\f05d2f02-f5bc-4734-9555-b200b88b94cc\\level.adofai"
 * Returns: "D:\\tuf-cdn\\levels\\f05d2f02-f5bc-4734-9555-b200b88b94cc"
 */
function findUuidFolderPath(filePath: string): string | null {
    const uuidRegex = /([a-f0-9-]{36})/;
    const match = filePath.match(uuidRegex);
    
    if (match) {
        const uuid = match[1];
        const uuidIndex = filePath.indexOf(uuid);
        if (uuidIndex !== -1) {
            // Find the end of the UUID folder (after the UUID)
            const afterUuid = filePath.substring(uuidIndex + uuid.length);
            // Check for both forward slash and backslash
            const nextSlash = afterUuid.search(/[/\\]/);
            if (nextSlash !== -1) {
                return filePath.substring(0, uuidIndex + uuid.length);
            } else {
                // If no slash after UUID, the path ends with the UUID folder
                return filePath;
            }
        }
    }
    
    return null;
}

/**
 * Update all path fields in metadata after moving a folder
 * Uses simple string replacement to update all absolute paths
 * Normalizes all paths to use forward slashes for consistent replacement
 */
function updateMetadataPaths(metadata: any, fromDrive: string, toDrive: string, fileId: string): any {
    // Normalize drive paths to use forward slashes
    const normalizedFromDrive = fromDrive.replace(/\\\\/g, '/');
    const normalizedToDrive = toDrive.replace(/\\\\/g, '/');
    
    logger.info('Normalized from drive:', {
        normalizedFromDrive
    });

    logger.info('Normalized to drive:', {
        normalizedToDrive
    });

    // Convert metadata to JSON string for easy replacement
    let metadataString = JSON.stringify(metadata).replace(/\\\\/g, '/');
    
    logger.info('Metadata string:', {
        metadataString
    });

    // Replace all occurrences of the old drive path with the new one
    // This will match both forward slashes and double backslashes in the JSON
    const updatedMetadataString = metadataString.replace(
        new RegExp(normalizedFromDrive, 'g'),
        normalizedToDrive
    );
    
    logger.info('Updated metadata string:', {
        updatedMetadataString
    });

    // Parse back to object
    const updatedMetadata = JSON.parse(updatedMetadataString);
    
    // Add redistribution tracking
    updatedMetadata.redistributedAt = new Date().toISOString();
    updatedMetadata.redistributedFrom = fromDrive;
    updatedMetadata.redistributedTo = toDrive;
    
    logger.info('Updated metadata paths:', {
        fileId,
        fromDrive: normalizedFromDrive,
        toDrive: normalizedToDrive,
        replacements: (metadataString.match(new RegExp(normalizedFromDrive, 'g')) || []).length
    });
    
    return updatedMetadata;
}

/**
 * Redistribute files across drives by moving entire UUID folders
 * This simplified approach moves whole folders instead of individual files
 */
export async function redistributeFilesAcrossDrives(batchSize?: number): Promise<void> {
    let transaction: Transaction | undefined;
    
    try {
        logger.info('Starting simplified file redistribution by moving entire UUID folders', {
            batchSize: batchSize || 'all'
        });
        
        // Get drive status
        const drives = storageManager.getDrivesStatus();
        if (drives.length < 2) {
            logger.info('Only one drive available, no redistribution needed');
            return;
        }
        
        logger.info('Available drives for redistribution:', {
            drives: drives.map(d => ({
                path: d.drivePath,
                availableSpace: `${d.availableSpace} GB`,
                usagePercentage: `${d.usagePercentage}%`,
                isAvailable: d.usagePercentage < 99 // Using 99% threshold
            }))
        });
        
        // Start transaction
        transaction = await sequelize.transaction();
        
        // Get all local files that can be moved
        const whereClause: any = {
            type: 'LEVELZIP',
            metadata: {
                storageType: StorageType.LOCAL
            }
        };
        
        const queryOptions: any = {
            where: whereClause,
            transaction
        };
        
        if (batchSize && batchSize > 0) {
            queryOptions.limit = batchSize;
            queryOptions.order = [['createdAt', 'DESC']];
        }
        
        const filesToRedistribute = await CdnFile.findAll(queryOptions);
        
        logger.info(`Found ${filesToRedistribute.length} local files to redistribute`);
        
        let redistributedCount = 0;
        let errorCount = 0;
        const redistributionResults: Array<{
            fileId: string;
            success: boolean;
            fromDrive?: string;
            toDrive?: string;
            error?: string;
        }> = [];
        
        for (const file of filesToRedistribute) {
            try {
                const metadata = file.metadata as any || {};
                
                // Determine current drive by checking targetLevel or any file path
                let currentDrive: string | null = null;
                let uuidFolderPath: string | null = null;
                
                // Check targetLevel first (most reliable)
                if (metadata.targetLevel) {
                    currentDrive = detectCurrentDrive(metadata.targetLevel);
                    if (currentDrive) {
                        uuidFolderPath = findUuidFolderPath(metadata.targetLevel);
                    }
                }
                
                // If not found in targetLevel, check levelFiles
                if (!currentDrive && metadata.levelFiles) {
                    for (const levelFile of Object.values(metadata.levelFiles) as any[]) {
                        if (levelFile.path) {
                            currentDrive = detectCurrentDrive(levelFile.path);
                            if (currentDrive) {
                                uuidFolderPath = findUuidFolderPath(levelFile.path);
                                break;
                            }
                        }
                    }
                }
                
                // Fallback: extract drive from path directly (for Windows paths like D:\...)
                if (!currentDrive && metadata.targetLevel) {
                    const driveMatch = metadata.targetLevel.match(/^([A-Za-z]:)/);
                    if (driveMatch) {
                        currentDrive = driveMatch[1];
                        uuidFolderPath = findUuidFolderPath(metadata.targetLevel);
                        logger.info('Using fallback drive detection:', {
                            fileId: file.id,
                            detectedDrive: currentDrive,
                            targetLevel: metadata.targetLevel
                        });
                    }
                }
                
                if (!currentDrive || !uuidFolderPath) {
                    logger.warn('Could not determine current drive or UUID folder, skipping:', {
                        fileId: file.id,
                        currentDrive,
                        uuidFolderPath,
                        targetLevel: metadata.targetLevel,
                        storageDrivesEnv: process.env.STORAGE_DRIVES,
                        levelFiles: metadata.levelFiles ? Object.keys(metadata.levelFiles) : 'none'
                    });
                    continue;
                }
                
                // Find the best target drive using percentage-based approach
                let targetDrive: string | null = null;
                const folderSize = await getFolderSize(uuidFolderPath);
                
                logger.info('Checking drive space for folder:', {
                    fileId: file.id,
                    folderSize: `${Math.round(folderSize / (1024**2))} MB`,
                    currentDrive: currentDrive,
                    uuidFolderPath: uuidFolderPath
                });
                
                // Use the storage manager's percentage-based drive selection
                // Try 'most_occupied' first to fill up drives efficiently
                const bestDrive = storageManager.getBestDriveForRedistribution('most_occupied');
                
                if (bestDrive) {
                    targetDrive = bestDrive.storagePath;
                } else {
                    // Fallback to 'least_occupied' if no drive is available with 'most_occupied' strategy
                    const fallbackDrive = storageManager.getBestDriveForRedistribution('least_occupied');
                    if (fallbackDrive) {
                        targetDrive = fallbackDrive.storagePath;
                    }
                }
                
                if (!targetDrive) {
                    logger.warn('No suitable drive found below threshold, skipping:', {
                        fileId: file.id,
                        folderSize: `${Math.round(folderSize / (1024**2))} MB`,
                        uuidFolderPath,
                        threshold: '99%'
                    });
                    continue;
                }
                
                // Skip if file is already on the target drive
                if (currentDrive === targetDrive) {
                    logger.info('File already on target drive, skipping:', {
                        fileId: file.id,
                        drive: currentDrive
                    });
                    continue;
                }
                
                logger.info('Redistributing UUID folder:', {
                    fileId: file.id,
                    fromDrive: currentDrive,
                    toDrive: targetDrive,
                    uuidFolderPath,
                    folderSize: `${Math.round(folderSize / (1024**2))} MB`,
                    strategy: 'percentage-based (most_occupied)'
                });
                
                // Verify source folder exists before attempting to move
                if (!fs.existsSync(uuidFolderPath)) {
                    logger.warn('Source folder does not exist, skipping:', {
                        fileId: file.id,
                        uuidFolderPath,
                        currentDrive,
                        targetDrive
                    });
                    continue;
                }
                
                // Create new folder path on target drive
                const relativePath = path.relative(currentDrive, uuidFolderPath);
                const newFolderPath = path.join(targetDrive, relativePath);
                
                // Note: Directory structure is ensured by storageManager.getBestDriveForRedistribution()
                // Move the entire folder (handle cross-drive moves)
                await moveFolderCrossDrive(uuidFolderPath, newFolderPath);
                
                // Update metadata with new paths
                const updatedMetadata = updateMetadataPaths(metadata, currentDrive, targetDrive, file.id);
                
                await file.update({
                    metadata: updatedMetadata
                }, { transaction });
                
                redistributedCount++;
                redistributionResults.push({
                    fileId: file.id,
                    success: true,
                    fromDrive: currentDrive,
                    toDrive: targetDrive
                });
                
                logger.info('Successfully redistributed UUID folder:', {
                    fileId: file.id,
                    fromDrive: currentDrive,
                    toDrive: targetDrive,
                    fromPath: uuidFolderPath,
                    toPath: newFolderPath
                });
                
                if (redistributedCount % 10 === 0) {
                    logger.info(`Redistribution progress: ${redistributedCount}/${filesToRedistribute.length} files processed`);
                }
                
            } catch (error) {
                errorCount++;
                const errorMessage = error instanceof Error ? error.message : String(error);
                
                redistributionResults.push({
                    fileId: file.id,
                    success: false,
                    error: errorMessage
                });
                
                logger.error('Error redistributing file:', {
                    fileId: file.id,
                    error: errorMessage
                });
            }
        }
        
        // Commit transaction
        await transaction.commit();
        
        // Log detailed results
        const successRate = filesToRedistribute.length > 0 ? ((redistributedCount / filesToRedistribute.length) * 100).toFixed(2) : '0';
        
        logger.info('File redistribution completed:', {
            totalFiles: filesToRedistribute.length,
            redistributedCount,
            errorCount,
            successRate: `${successRate}%`,
            batchSize: batchSize || 'unlimited'
        });
        
        // Log failed redistributions for debugging
        const failedRedistributions = redistributionResults.filter(r => !r.success);
        if (failedRedistributions.length > 0) {
            logger.warn('Failed redistributions summary:', {
                failedCount: failedRedistributions.length,
                failedFileIds: failedRedistributions.map(f => f.fileId),
                sampleErrors: failedRedistributions.slice(0, 5).map(f => ({
                    fileId: f.fileId,
                    error: f.error
                }))
            });
        }
        
    } catch (error) {
        // Rollback transaction if it exists
        if (transaction) {
            try {
                await safeTransactionRollback(transaction);
            } catch (rollbackError) {
                logger.warn('Transaction rollback failed:', rollbackError);
            }
        }
        
        logger.error('File redistribution failed:', {
            error: error instanceof Error ? error.message : String(error)
        });
        throw error;
    }
}

/**
 * Helper function to calculate folder size
 */
async function getFolderSize(folderPath: string): Promise<number> {
    try {
        let totalSize = 0;
        
        const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(folderPath, entry.name);
            
            if (entry.isDirectory()) {
                totalSize += await getFolderSize(fullPath);
            } else {
                const stats = await fs.promises.stat(fullPath);
                totalSize += stats.size;
            }
        }
        
        return totalSize;
    } catch (error) {
        logger.warn('Failed to calculate folder size:', {
            folderPath,
            error: error instanceof Error ? error.message : String(error)
        });
        return 0;
    }
}

/**
 * Move a folder across drives (handles cross-device link errors)
 * Uses copy-and-delete approach for cross-drive moves
 */
async function moveFolderCrossDrive(sourcePath: string, targetPath: string): Promise<void> {
    try {
        // Verify source exists before attempting move
        if (!fs.existsSync(sourcePath)) {
            throw new Error(`Source folder does not exist: ${sourcePath}`);
        }
        
        // Verify source is actually a directory
        const sourceStats = await fs.promises.stat(sourcePath);
        if (!sourceStats.isDirectory()) {
            throw new Error(`Source path is not a directory: ${sourcePath}`);
        }
        
        logger.info('Starting folder move operation:', {
            from: sourcePath,
            to: targetPath,
            sourceExists: true,
            sourceIsDirectory: true
        });
        
        // First, try a simple rename (works for same-drive moves)
        try {
            await fs.promises.rename(sourcePath, targetPath);
            logger.info('Successfully moved folder (same drive):', {
                from: sourcePath,
                to: targetPath
            });
            return;
        } catch (renameError) {
            // If rename fails with EXDEV error, it's a cross-drive move
            if (renameError instanceof Error && renameError.message.includes('EXDEV')) {
                logger.info('Cross-drive move detected, using copy-and-delete approach:', {
                    from: sourcePath,
                    to: targetPath
                });
                
                // Use copy-and-delete for cross-drive moves
                await copyFolderRecursive(sourcePath, targetPath);
                await fs.promises.rm(sourcePath, { recursive: true, force: true });
                
                logger.info('Successfully moved folder (cross-drive):', {
                    from: sourcePath,
                    to: targetPath
                });
            } else {
                // Re-throw if it's a different error
                throw renameError;
            }
        }
    } catch (error) {
        logger.error('Failed to move folder:', {
            from: sourcePath,
            to: targetPath,
            error: error instanceof Error ? error.message : String(error),
            sourceExists: fs.existsSync(sourcePath)
        });
        throw error;
    }
}

/**
 * Recursively copy a folder and all its contents
 */
async function copyFolderRecursive(sourcePath: string, targetPath: string): Promise<void> {
    // Ensure target directory exists
    await fs.promises.mkdir(targetPath, { recursive: true });
    
    const entries = await fs.promises.readdir(sourcePath, { withFileTypes: true });
    
    for (const entry of entries) {
        const sourceEntryPath = path.join(sourcePath, entry.name);
        const targetEntryPath = path.join(targetPath, entry.name);
        
        if (entry.isDirectory()) {
            // Recursively copy subdirectories
            await copyFolderRecursive(sourceEntryPath, targetEntryPath);
        } else {
            // Copy files
            await fs.promises.copyFile(sourceEntryPath, targetEntryPath);
        }
    }
}

/**
 * Get statistics about files that need migration
 */
export async function getMigrationStats(): Promise<{
    totalFiles: number;
    filesNeedingMigration: number;
    byType: Record<string, number>;
    byStorageType: Record<string, number>;
}> {
    try {
        logger.info('Getting migration statistics');
        
        // Get total count of all CDN files
        const totalFiles = await CdnFile.count();
        
        // Get count of files needing migration
        const filesNeedingMigration = await CdnFile.count({
            where: {
                [Op.or]: [
                    { metadata: null },
                    { metadata: { storageType: null } },
                    { metadata: { [Op.not]: { storageType: { [Op.ne]: null } } } }
                ]
            }
        });
        
        // Get breakdown by file type
        const byType = await CdnFile.findAll({
            attributes: [
                'type',
                [sequelize.fn('COUNT', sequelize.col('id')), 'count']
            ],
            where: {
                [Op.or]: [
                    { metadata: null },
                    { metadata: { storageType: null } },
                    { metadata: { [Op.not]: { storageType: { [Op.ne]: null } } } }
                ]
            },
            group: ['type'],
            raw: true
        });
        
        // Get breakdown by existing storage type (for files that already have it)
        const byStorageType = await CdnFile.findAll({
            attributes: [
                [sequelize.literal("JSON_EXTRACT(metadata, '$.storageType')"), 'storageType'],
                [sequelize.fn('COUNT', sequelize.col('id')), 'count']
            ],
            where: {
                metadata: {
                    storageType: {
                        [Op.ne]: null
                    }
                }
            },
            group: [sequelize.literal("JSON_EXTRACT(metadata, '$.storageType')") as any],
            raw: true
        });
        
        const stats = {
            totalFiles,
            filesNeedingMigration,
            byType: byType.reduce((acc, item: any) => {
                acc[item.type] = parseInt(item.count as string);
                return acc;
            }, {} as Record<string, number>),
            byStorageType: byStorageType.reduce((acc, item: any) => {
                const storageType = item.storageType || 'unknown';
                acc[storageType] = parseInt(item.count as string);
                return acc;
            }, {} as Record<string, number>)
        };
        
        logger.info('Migration statistics:', stats);
        return stats;
        
    } catch (error) {
        logger.error('Failed to get migration statistics:', {
            error: error instanceof Error ? error.message : String(error)
        });
        throw error;
    }
}

/**
 * Test migration with a small batch of specific file type
 */
export async function testMigration(batchSize: number = 5, fileType: string = 'LEVELZIP'): Promise<void> {
    try {
        logger.info('Starting test migration', { batchSize, fileType });
        
        // Get stats before migration
        const statsBefore = await getMigrationStats();
        
        // Run migration on small batch
        await migrateStorageTypes(batchSize, fileType);
        
        // Get stats after migration
        const statsAfter = await getMigrationStats();
        
        // Verify results
        await verifyMigration();
        
        logger.info('Test migration completed successfully', {
            batchSize,
            fileType,
            statsBefore,
            statsAfter,
            migratedInTest: statsBefore.filesNeedingMigration - statsAfter.filesNeedingMigration
        });
        
    } catch (error) {
        logger.error('Test migration failed:', {
            error: error instanceof Error ? error.message : String(error)
        });
        throw error;
    }
}

/**
 * Run migration in batches with progress tracking
 */
export async function runBatchMigration(
    batchSize: number = 100, 
    fileType?: string,
    maxBatches?: number
): Promise<void> {
    try {
        logger.info('Starting batch migration', { batchSize, fileType, maxBatches });
        
        let totalProcessed = 0;
        let batchNumber = 0;
        let hasMoreFiles = true;
        
        while (hasMoreFiles && (!maxBatches || batchNumber < maxBatches)) {
            batchNumber++;
            
            logger.info(`Starting batch ${batchNumber}`, {
                batchSize,
                fileType: fileType || 'all',
                totalProcessed
            });
            
            // Get count of remaining files before this batch
            const remainingBefore = await CdnFile.count({
                where: {
                    [Op.or]: [
                        { metadata: null },
                        { metadata: { storageType: null } },
                        { metadata: { [Op.not]: { storageType: { [Op.ne]: null } } } }
                    ],
                    ...(fileType && { type: fileType })
                }
            });
            
            if (remainingBefore === 0) {
                logger.info('No more files to migrate');
                hasMoreFiles = false;
                break;
            }
            
            // Run migration for this batch
            await migrateStorageTypes(batchSize, fileType);
            
            // Get count of remaining files after this batch
            const remainingAfter = await CdnFile.count({
                where: {
                    [Op.or]: [
                        { metadata: null },
                        { metadata: { storageType: null } },
                        { metadata: { [Op.not]: { storageType: { [Op.ne]: null } } } }
                    ],
                    ...(fileType && { type: fileType })
                }
            });
            
            const processedInBatch = remainingBefore - remainingAfter;
            totalProcessed += processedInBatch;
            
            logger.info(`Completed batch ${batchNumber}`, {
                processedInBatch,
                totalProcessed,
                remainingAfter,
                hasMoreFiles: remainingAfter > 0
            });
            
            // Check if we processed fewer files than the batch size (end of data)
            if (processedInBatch < batchSize) {
                hasMoreFiles = false;
            }
            
            // Small delay between batches to avoid overwhelming the system
            if (hasMoreFiles) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        logger.info('Batch migration completed', {
            totalBatches: batchNumber,
            totalProcessed,
            batchSize,
            fileType: fileType || 'all'
        });
        
    } catch (error) {
        logger.error('Batch migration failed:', {
            error: error instanceof Error ? error.message : String(error)
        });
        throw error;
    }
}

const program = new Command();

program
  .name('migrate-storage-types')
  .description('Migrate CDN files to add storage type information for hybrid storage support')
  .version('1.0.0');

program
  .command('migrate')
  .description('Migrate files to add storage type information')
  .option('-b, --batch-size <number>', 'Number of files to process in each batch', '100')
  .option('-t, --file-type <type>', 'File type to migrate (LEVELZIP, PROFILE, etc.)')
  .action(async (options) => {
    try {
      logger.info('Starting storage type migration...');
      
      const batchSize = parseInt(options.batchSize);
      const fileType = options.fileType;
      
      await migrateStorageTypes(batchSize, fileType);
      await verifyMigration();
      
      console.log('\n=== Migration Results ===');
      console.log('Storage type migration completed successfully!');
      
      process.exit(0);
    } catch (error) {
      logger.error('Migration failed:', error);
      console.error('Migration failed:', error);
      process.exit(1);
    }
  });

program
  .command('test')
  .description('Test migration with a small batch of files')
  .option('-b, --batch-size <number>', 'Number of files to test with', '5')
  .option('-t, --file-type <type>', 'File type to test with', 'LEVELZIP')
  .action(async (options) => {
    try {
      logger.info('Starting test migration...');
      
      const batchSize = parseInt(options.batchSize);
      const fileType = options.fileType;
      
      await testMigration(batchSize, fileType);
      
      console.log('\n=== Test Results ===');
      console.log('Test migration completed successfully!');
      
      process.exit(0);
    } catch (error) {
      logger.error('Test migration failed:', error);
      console.error('Test migration failed:', error);
      process.exit(1);
    }
  });

program
  .command('batch')
  .description('Run migration in batches with progress tracking')
  .option('-b, --batch-size <number>', 'Number of files per batch', '100')
  .option('-t, --file-type <type>', 'File type to migrate')
  .option('-m, --max-batches <number>', 'Maximum number of batches to run')
  .action(async (options) => {
    try {
      logger.info('Starting batch migration...');
      
      const batchSize = parseInt(options.batchSize);
      const fileType = options.fileType;
      const maxBatches = options.maxBatches ? parseInt(options.maxBatches) : undefined;
      
      await runBatchMigration(batchSize, fileType, maxBatches);
      
      console.log('\n=== Batch Migration Results ===');
      console.log('Batch migration completed successfully!');
      
      process.exit(0);
    } catch (error) {
      logger.error('Batch migration failed:', error);
      console.error('Batch migration failed:', error);
      process.exit(1);
    }
  });

program
  .command('stats')
  .description('Show migration statistics')
  .action(async () => {
    try {
      logger.info('Gathering migration statistics...');
      
      const stats = await getMigrationStats();
      
      console.log('\n=== Migration Statistics ===');
      console.log(`Total files: ${stats.totalFiles}`);
      console.log(`Files needing migration: ${stats.filesNeedingMigration}`);
      console.log(`Migration progress: ${(((stats.totalFiles - stats.filesNeedingMigration) / stats.totalFiles) * 100).toFixed(1)}%`);
      
      if (Object.keys(stats.byType).length > 0) {
        console.log('\n=== Files Needing Migration by Type ===');
        Object.entries(stats.byType)
          .sort(([,a], [,b]) => b - a)
          .forEach(([type, count]) => {
            console.log(`${type}: ${count} files`);
          });
      }
      
      if (Object.keys(stats.byStorageType).length > 0) {
        console.log('\n=== Current Storage Type Distribution ===');
        Object.entries(stats.byStorageType)
          .sort(([,a], [,b]) => b - a)
          .forEach(([storageType, count]) => {
            console.log(`${storageType}: ${count} files`);
          });
      }
      
      process.exit(0);
    } catch (error) {
      logger.error('Statistics gathering failed:', error);
      console.error('Statistics gathering failed:', error);
      process.exit(1);
    }
  });

program
  .command('verify')
  .description('Verify migration results')
  .action(async () => {
    try {
      logger.info('Starting migration verification...');
      
      await verifyMigration();
      
      console.log('\n=== Verification Results ===');
      console.log('Migration verification completed successfully!');
      
      process.exit(0);
    } catch (error) {
      logger.error('Verification failed:', error);
      console.error('Verification failed:', error);
      process.exit(1);
    }
  });

program
  .command('migrate-to-spaces')
  .description('Migrate local zip files to DigitalOcean Spaces')
  .option('-b, --batch-size <number>', 'Number of files to process in each batch', '10')
  .action(async (options) => {
    try {
      logger.info('Starting migration of local zips to Spaces...');
      
      const batchSize = parseInt(options.batchSize);
      
      await migrateLocalZipsToSpaces(batchSize);
      
      console.log('\n=== Migration to Spaces Results ===');
      console.log('Local zip migration to Spaces completed successfully!');
      
      process.exit(0);
    } catch (error) {
      logger.error('Migration to Spaces failed:', error);
      console.error('Migration to Spaces failed:', error);
      process.exit(1);
    }
  });

program
  .command('drive-stats')
  .description('Show drive usage statistics')
  .action(async () => {
    try {
      logger.info('Gathering drive usage statistics...');
      
      const stats = await getDriveUsageStats();
      
      console.log('\n=== Drive Usage Statistics ===');
      console.log(`Total zip files: ${stats.totalFiles}`);
      console.log(`Files in Spaces: ${stats.filesInSpaces}`);
      console.log(`Files local: ${stats.filesLocal}`);
      console.log(`Migration progress: ${((stats.filesInSpaces / stats.totalFiles) * 100).toFixed(1)}%`);
      
      console.log('\n=== Drive Information ===');
      stats.drives.forEach(drive => {
        console.log(`\nDrive ${drive.drive}:`);
        console.log(`  Total Space: ${drive.totalSpace}`);
        console.log(`  Used Space: ${drive.usedSpace}`);
        console.log(`  Available Space: ${drive.availableSpace}`);
        console.log(`  Usage: ${drive.usagePercentage}`);
        console.log(`  CDN Files: ${drive.fileCount}`);
      });
      
      process.exit(0);
    } catch (error) {
      logger.error('Drive statistics gathering failed:', error);
      console.error('Drive statistics gathering failed:', error);
      process.exit(1);
    }
  });

program
  .command('migrate-hybrid')
  .description('Migrate to hybrid storage strategy: zip files in Spaces, transformation files locally')
  .option('-b, --batch-size <number>', 'Number of files to process in each batch', '10')
  .action(async (options) => {
    try {
      logger.info('Starting migration to hybrid storage strategy...');
      
      const batchSize = parseInt(options.batchSize);
      
      await migrateToHybridStrategy(batchSize);
      
      console.log('\n=== Hybrid Strategy Migration Results ===');
      console.log('Hybrid storage strategy migration completed successfully!');
      console.log('Zip files are now in Spaces, transformation files (.adofai, songs) are local.');
      
      process.exit(0);
    } catch (error) {
      logger.error('Hybrid strategy migration failed:', error);
      console.error('Hybrid strategy migration failed:', error);
      process.exit(1);
    }
  });

program
  .command('migrate-songs')
  .description('Migrate local song files to DigitalOcean Spaces')
  .option('-b, --batch-size <number>', 'Number of files to process in each batch', '10')
  .action(async (options) => {
    try {
      logger.info('Starting migration of local song files to Spaces...');
      
      const batchSize = parseInt(options.batchSize);
      
      await migrateLocalSongFiles(batchSize);
      
      console.log('\n=== Song Files Migration Results ===');
      console.log('Local song files migration to Spaces completed successfully!');
      console.log('Song files are now stored in DigitalOcean Spaces for better performance.');
      
      process.exit(0);
    } catch (error) {
      logger.error('Song files migration failed:', error);
      console.error('Song files migration failed:', error);
      process.exit(1);
    }
  });

program
  .command('redistribute-drives')
  .description('Redistribute files across drives to prioritize filling first drives completely')
  .option('-b, --batch-size <number>', 'Number of files to process in each batch', '50')
  .action(async (options) => {
    try {
      logger.info('Starting file redistribution across drives...');
      
      const batchSize = parseInt(options.batchSize);
      
      await redistributeFilesAcrossDrives(batchSize);
      
      console.log('\n=== Drive Redistribution Results ===');
      console.log('File redistribution completed successfully!');
      console.log('Files have been redistributed to prioritize filling first drives completely.');
      
      process.exit(0);
    } catch (error) {
      logger.error('Drive redistribution failed:', error);
      console.error('Drive redistribution failed:', error);
      process.exit(1);
    }
  });

// Parse command line arguments
program.parse();
