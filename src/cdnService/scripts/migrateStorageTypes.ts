#!/usr/bin/env ts-node

import { Command } from 'commander';
import { logger } from '../../services/LoggerService.js';
import CdnFile from '../../models/cdn/CdnFile.js';
import { hybridStorageManager, StorageType } from '../services/hybridStorageManager.js';
import sequelize from '../../config/db.js';
import { Transaction, Op } from 'sequelize';
import { safeTransactionRollback } from '../../utils/Utility.js';

/**
 * Migration script to add storage type information to existing CDN file entries
 * This ensures that all files have proper storage type metadata for fallback logic
 */
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

// Parse command line arguments
program.parse();
