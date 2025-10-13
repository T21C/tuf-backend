import { logger } from '../../services/LoggerService.js';
import { storageManager } from './storageManager.js';
import { spacesStorage } from './spacesStorage.js';
import path from 'path';
import fs from 'fs';
import { CDN_CONFIG } from '../config.js';
import dotenv from 'dotenv';

dotenv.config();

export enum StorageType {
    LOCAL = 'local',
    SPACES = 'spaces',
    HYBRID = 'hybrid'
}

interface StorageConfig {
    type: StorageType;
    useSpacesForLevels: boolean;
    useSpacesForSongs: boolean;
    useSpacesForImages: boolean;
    useSpacesForZips: boolean;
    fallbackToLocal: boolean;
}

export class HybridStorageManager {
    private static instance: HybridStorageManager;
    private config: StorageConfig;

    constructor() {
        this.config = this.loadConfig();
        logger.info('HybridStorageManager initialized', this.config);
    }

    public static getInstance(): HybridStorageManager {
        if (!HybridStorageManager.instance) {
            HybridStorageManager.instance = new HybridStorageManager();
        }
        return HybridStorageManager.instance;
    }

    private loadConfig(): StorageConfig {
        const storageType = (process.env.STORAGE_TYPE as StorageType) || StorageType.HYBRID;
        const useSpacesForLevels = process.env.USE_SPACES_FOR_LEVELS === 'true';
        const useSpacesForSongs = process.env.USE_SPACES_FOR_SONGS === 'true';
        const useSpacesForImages = process.env.USE_SPACES_FOR_IMAGES === 'true';
        const useSpacesForZips = process.env.USE_SPACES_FOR_ZIPS === 'true';
        const fallbackToLocal = process.env.SPACES_FALLBACK_TO_LOCAL !== 'false';

        return {
            type: storageType,
            useSpacesForLevels,
            useSpacesForSongs,
            useSpacesForImages,
            useSpacesForZips,
            fallbackToLocal
        };
    }

    /**
     * Upload a level file (zip or extracted files)
     */
    public async uploadLevelFile(
        filePath: string,
        fileId: string,
        originalFilename: string,
        isZip = false
    ): Promise<{
        storageType: StorageType;
        filePath: string;
        url?: string;
        key?: string;
        originalFilename?: string;
    }> {
        try {

            if (this.config.useSpacesForSongs && this.config.type !== StorageType.LOCAL) {
                try {
                    const keyResult = isZip
                        ? spacesStorage.generateZipKey(fileId, originalFilename)
                        : spacesStorage.generateLevelKey(fileId, originalFilename);

                    const contentType = isZip ? 'application/zip' : 'application/json';

                    const result = await spacesStorage.uploadFile(filePath, keyResult.key, contentType, {
                        fileId,
                        originalFilename: encodeURIComponent(keyResult.originalFilename),
                        uploadType: isZip ? 'zip' : 'level',
                        uploadedAt: new Date().toISOString()
                    });

                    logger.debug('Level file uploaded to Spaces', {
                        fileId,
                        originalFilename: keyResult.originalFilename,
                        isZip,
                        key: result.key,
                        size: result.size
                    });

                    return {
                        storageType: StorageType.SPACES,
                        filePath: result.key,
                        url: result.url,
                        key: result.key,
                        originalFilename: keyResult.originalFilename
                    };
                } catch (error) {
                    logger.error('Failed to upload to Spaces, falling back to local storage', {
                        error: error instanceof Error ? error.message : String(error),
                        fileId,
                        originalFilename,
                        isZip
                    });

                    if (!this.config.fallbackToLocal) {
                        throw error;
                    }
                }
            }

            // Use local storage
            const localPath = await this.getLocalStoragePath(fileId, originalFilename, isZip);
            await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
            await fs.promises.copyFile(filePath, localPath);

            logger.debug('Level file stored locally', {
                fileId,
                originalFilename,
                isZip,
                localPath
            });

            return {
                storageType: StorageType.LOCAL,
                filePath: localPath,
                originalFilename: originalFilename
            };
        } catch (error) {
            logger.error('Failed to upload level file', {
                error: error instanceof Error ? error.message : String(error),
                fileId,
                originalFilename,
                isZip
            });
            throw error;
        }
    }

    /**
     * Upload song files to Spaces only
     */
    public async uploadSongFiles(
        files: Array<{ sourcePath: string; filename: string; size: number; type: string }>,
        fileId: string
    ): Promise<{
        storageType: StorageType;
        files: Array<{
            filename: string;
            path: string;
            size: number;
            type: string;
            url?: string;
            key?: string;
        }>;
    }> {
        try {
            const results: Array<{
                filename: string;
                path: string;
                size: number;
                type: string;
                url?: string;
                key?: string;
            }> = [];

            // Upload all song files to Spaces
            for (const file of files) {
                const spacesKey = `zips/${fileId}/${file.filename}`;

                const result = await spacesStorage.uploadFile(
                    file.sourcePath,
                    spacesKey,
                    `audio/${file.type}`,
                    {
                        fileId,
                        originalFilename: encodeURIComponent(file.filename),
                        uploadType: 'song',
                        uploadedAt: new Date().toISOString()
                    }
                );

                results.push({
                    filename: file.filename,
                    path: result.key,
                    size: file.size,
                    type: file.type,
                    url: result.url,
                    key: result.key
                });
            }

            logger.debug('All song files uploaded to Spaces', {
                fileId,
                fileCount: files.length,
                totalSize: files.reduce((sum, f) => sum + f.size, 0)
            });

            return {
                storageType: StorageType.SPACES,
                files: results
            };
        } catch (error) {
            logger.error('Failed to upload song files to Spaces', {
                error: error instanceof Error ? error.message : String(error),
                fileId,
                fileCount: files.length
            });
            throw error;
        }
    }

    /**
     * Upload multiple level files (extracted from zip)
     */
    public async uploadLevelFiles(
        files: Array<{ sourcePath: string; filename: string; size: number }>,
        fileId: string
    ): Promise<{
        storageType: StorageType;
        files: Array<{
            filename: string;
            path: string;
            size: number;
            url?: string;
            key?: string;
        }>;
    }> {
        try {
            const shouldUseSpaces = this.config.useSpacesForLevels && this.config.type !== StorageType.LOCAL;
            const results: Array<{
                filename: string;
                path: string;
                size: number;
                url?: string;
                key?: string;
            }> = [];

            if (shouldUseSpaces) {
                try {
                    // Upload all files to Spaces
                    for (const file of files) {
                        const keyResult = spacesStorage.generateLevelKey(fileId, file.filename);

                        const result = await spacesStorage.uploadFile(
                            file.sourcePath,
                            keyResult.key,
                            'application/json',
                            {
                                fileId,
                                originalFilename: encodeURIComponent(keyResult.originalFilename),
                                uploadType: 'level',
                                uploadedAt: new Date().toISOString()
                            }
                        );

                        results.push({
                            filename: file.filename,
                            path: result.key,
                            size: file.size,
                            url: result.url,
                            key: result.key
                        });
                    }

                    logger.debug('All level files uploaded to Spaces', {
                        fileId,
                        fileCount: files.length,
                        totalSize: files.reduce((sum, f) => sum + f.size, 0)
                    });

                    return {
                        storageType: StorageType.SPACES,
                        files: results
                    };
                } catch (error) {
                    logger.error('Failed to upload level files to Spaces, falling back to local storage', {
                        error: error instanceof Error ? error.message : String(error),
                        fileId,
                        fileCount: files.length
                    });

                    if (!this.config.fallbackToLocal) {
                        throw error;
                    }
                }
            }

            // Use local storage
            const storageRoot = await storageManager.getDrive();
            const levelDir = path.join(storageRoot, 'levels', fileId);
            await fs.promises.mkdir(levelDir, { recursive: true });

            for (const file of files) {
                const localPath = path.join(levelDir, file.filename);
                await fs.promises.copyFile(file.sourcePath, localPath);

                results.push({
                    filename: file.filename,
                    path: localPath,
                    size: file.size
                });
            }

            logger.debug('All level files stored locally', {
                fileId,
                fileCount: files.length,
                levelDir
            });

            return {
                storageType: StorageType.LOCAL,
                files: results
            };
        } catch (error) {
            logger.error('Failed to upload level files', {
                error: error instanceof Error ? error.message : String(error),
                fileId,
                fileCount: files.length
            });
            throw error;
        }
    }

    /**
     * Download a file from storage
     */
    public async downloadFile(
        filePath: string,
        storageType: StorageType,
        localPath?: string
    ): Promise<Buffer> {
        try {
            if (storageType === StorageType.SPACES) {
                return await spacesStorage.downloadFile(filePath, localPath);
            } else {
                // Local storage
                const buffer = await fs.promises.readFile(filePath);
                if (localPath) {
                    await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
                    await fs.promises.writeFile(localPath, buffer);
                }
                return buffer;
            }
        } catch (error) {
            logger.error('Failed to download file', {
                error: error instanceof Error ? error.message : String(error),
                filePath,
                storageType
            });
            throw error;
        }
    }

    /**
     * Delete a file from storage
     */
    public async deleteFile(filePath: string, storageType: StorageType): Promise<void> {
        try {
            if (storageType === StorageType.SPACES) {
                await spacesStorage.deleteFile(filePath);
            } else {
                // Local storage
                if (fs.existsSync(filePath)) {
                    await fs.promises.unlink(filePath);
                }
            }

            logger.debug('File deleted successfully', { filePath, storageType });
        } catch (error) {
            logger.error('Failed to delete file', {
                error: error instanceof Error ? error.message : String(error),
                filePath,
                storageType
            });
            throw error;
        }
    }

    /**
     * Delete all files associated with a level zip (including extracted files)
     * Uses folder-based deletion since all files for a fileId are contained within the same folder
     */

    public async deleteLevelZipFiles(fileId: string): Promise<void> {
        try {
            logger.debug('Deleting level zip folder from all storage types', {
                fileId,
                folderStructure: {
                    spaces: `levels/${fileId}/ and zips/${fileId}/`,
                    local: `{drive}/levels/${fileId}/ and {drive}/zips/${fileId}/`
                }
            });

            // Delete from both storage types using folder-based approach
            await this.deleteFolder(fileId);

            logger.debug('Successfully completed folder-based deletion of level zip files', {
                fileId
            });
        } catch (error) {
            logger.error('Failed to delete level zip files', {
                error: error instanceof Error ? error.message : String(error),
                fileId
            });
            throw error;
        }
    }

    /**
     * Delete multiple files from storage
     */
    public async deleteFiles(
        files: Array<{ path: string; storageType: StorageType }>
    ): Promise<void> {
        try {
            const spacesFiles: string[] = [];
            const localFiles: string[] = [];

            // Group files by storage type
            for (const file of files) {
                if (file.storageType === StorageType.SPACES) {
                    spacesFiles.push(file.path);
                } else {
                    localFiles.push(file.path);
                }
            }

            // Delete from Spaces
            if (spacesFiles.length > 0) {
                await spacesStorage.deleteFiles(spacesFiles);
            }

            // Delete from local storage
            for (const localFile of localFiles) {
                if (fs.existsSync(localFile)) {
                    await fs.promises.unlink(localFile);
                }
            }

            logger.debug('Files deleted successfully', {
                spacesCount: spacesFiles.length,
                localCount: localFiles.length
            });
        } catch (error) {
            logger.error('Failed to delete files', {
                error: error instanceof Error ? error.message : String(error),
                fileCount: files.length
            });
            throw error;
        }
    }

    /**
     * Comprehensive file deletion that attempts to delete from both storage types
     * This method is designed for cleanup scenarios where files might exist in both locations
     */
    public async deleteFilesComprehensive(
        files: Array<{ path: string; storageType: StorageType }>
    ): Promise<void> {
        try {
            const spacesFiles: string[] = [];
            const localFiles: string[] = [];
            const deletionResults: Array<{ path: string; storageType: StorageType; success: boolean; error?: string }> = [];

            // Group files by storage type
            for (const file of files) {
                if (file.storageType === StorageType.SPACES) {
                    spacesFiles.push(file.path);
                } else {
                    localFiles.push(file.path);
                }
            }

            // Delete from Spaces (with individual error handling)
            if (spacesFiles.length > 0) {
                try {
                    await spacesStorage.deleteFiles(spacesFiles);
                    spacesFiles.forEach(path => {
                        deletionResults.push({ path, storageType: StorageType.SPACES, success: true });
                    });
                    logger.debug('Successfully deleted files from Spaces', { count: spacesFiles.length });
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    logger.warn('Some files failed to delete from Spaces', {
                        error: errorMessage,
                        count: spacesFiles.length
                    });
                    spacesFiles.forEach(path => {
                        deletionResults.push({
                            path,
                            storageType: StorageType.SPACES,
                            success: false,
                            error: errorMessage
                        });
                    });
                }
            }

            // Delete from local storage (with individual error handling)
            for (const localFile of localFiles) {
                try {
                    if (fs.existsSync(localFile)) {
                        await fs.promises.unlink(localFile);
                        deletionResults.push({ path: localFile, storageType: StorageType.LOCAL, success: true });
                        logger.debug('Successfully deleted local file', { path: localFile });
                    } else {
                        deletionResults.push({ path: localFile, storageType: StorageType.LOCAL, success: true }); // File didn't exist, consider it "deleted"
                        logger.debug('Local file did not exist', { path: localFile });
                    }
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    deletionResults.push({
                        path: localFile,
                        storageType: StorageType.LOCAL,
                        success: false,
                        error: errorMessage
                    });
                    logger.warn('Failed to delete local file', {
                        path: localFile,
                        error: errorMessage
                    });
                }
            }

            // Log comprehensive results
            const successfulDeletions = deletionResults.filter(r => r.success).length;
            const failedDeletions = deletionResults.filter(r => !r.success).length;

            logger.debug('Comprehensive file deletion completed', {
                totalAttempts: files.length,
                successful: successfulDeletions,
                failed: failedDeletions,
                spacesAttempts: spacesFiles.length,
                localAttempts: localFiles.length
            });

            // If there were any failures, log them for debugging
            if (failedDeletions > 0) {
                const failures = deletionResults.filter(r => !r.success);
                logger.warn('Some file deletions failed', {
                    failures: failures.map(f => ({
                        path: f.path,
                        storageType: f.storageType,
                        error: f.error
                    }))
                });
            }
        } catch (error) {
            logger.error('Failed comprehensive file deletion', {
                error: error instanceof Error ? error.message : String(error),
                fileCount: files.length
            });
            throw error;
        }
    }

    /**
     * Comprehensive folder deletion that attempts to delete from both storage types
     * This method deletes entire folders (levels/{fileId}/ and zips/{fileId}/) from both Spaces and local storage
     */
    public async deleteFolder(fileId: string): Promise<void> {
        try {
            const deletionResults: Array<{
                folder: string;
                storageType: StorageType;
                success: boolean;
                error?: string;
                filesDeleted?: number;
            }> = [];

            // Define the folder prefixes to delete
            const foldersToDelete = [
                `levels/${fileId}/`,
                `zips/${fileId}/`
            ];

            // Delete from Spaces
            for (const folderPrefix of foldersToDelete) {
                try {
                    // List all files in the folder
                    const files = await spacesStorage.listFiles(folderPrefix, 10000);

                    if (files.length > 0) {
                        // Delete all files in the folder
                        const fileKeys = files.map(file => file.key);
                        await spacesStorage.deleteFiles(fileKeys);

                        deletionResults.push({
                            folder: folderPrefix,
                            storageType: StorageType.SPACES,
                            success: true,
                            filesDeleted: files.length
                        });

                        logger.debug('Successfully deleted folder from Spaces', {
                            folder: folderPrefix,
                            filesDeleted: files.length
                        });
                    } else {
                        deletionResults.push({
                            folder: folderPrefix,
                            storageType: StorageType.SPACES,
                            success: true,
                            filesDeleted: 0
                        });

                        logger.debug('Folder was empty in Spaces', { folder: folderPrefix });
                    }
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    deletionResults.push({
                        folder: folderPrefix,
                        storageType: StorageType.SPACES,
                        success: false,
                        error: errorMessage
                    });

                    logger.warn('Failed to delete folder from Spaces', {
                        folder: folderPrefix,
                        error: errorMessage
                    });
                }
            }

            // Delete from local storage
            try {
                const storageRoot = await storageManager.getDrive();

                for (const folderPrefix of foldersToDelete) {
                    const localFolderPath = path.join(storageRoot, folderPrefix);

                    try {
                        if (fs.existsSync(localFolderPath)) {
                            // Count files before deletion for logging
                            const files = await fs.promises.readdir(localFolderPath, { withFileTypes: true });
                            const fileCount = files.filter(file => file.isFile()).length;

                            // Delete the entire folder recursively
                            await fs.promises.rm(localFolderPath, { recursive: true, force: true });

                            deletionResults.push({
                                folder: folderPrefix,
                                storageType: StorageType.LOCAL,
                                success: true,
                                filesDeleted: fileCount
                            });

                            logger.debug('Successfully deleted folder from local storage', {
                                folder: folderPrefix,
                                localPath: localFolderPath,
                                filesDeleted: fileCount
                            });
                        } else {
                            deletionResults.push({
                                folder: folderPrefix,
                                storageType: StorageType.LOCAL,
                                success: true,
                                filesDeleted: 0
                            });

                            logger.debug('Folder did not exist in local storage', {
                                folder: folderPrefix,
                                localPath: localFolderPath
                            });
                        }
                    } catch (error) {
                        const errorMessage = error instanceof Error ? error.message : String(error);
                        deletionResults.push({
                            folder: folderPrefix,
                            storageType: StorageType.LOCAL,
                            success: false,
                            error: errorMessage
                        });

                        logger.warn('Failed to delete folder from local storage', {
                            folder: folderPrefix,
                            localPath: localFolderPath,
                            error: errorMessage
                        });
                    }
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                logger.error('Failed to access local storage for folder deletion', {
                    error: errorMessage,
                    fileId
                });
            }

            // Log comprehensive results
            const successfulDeletions = deletionResults.filter(r => r.success).length;
            const failedDeletions = deletionResults.filter(r => !r.success).length;
            const totalFilesDeleted = deletionResults
                .filter(r => r.success)
                .reduce((sum, r) => sum + (r.filesDeleted || 0), 0);

            logger.debug('Comprehensive folder deletion completed', {
                fileId,
                totalFolders: foldersToDelete.length,
                successful: successfulDeletions,
                failed: failedDeletions,
                totalFilesDeleted
            });

            // If there were any failures, log them for debugging
            if (failedDeletions > 0) {
                const failures = deletionResults.filter(r => !r.success);
                logger.warn('Some folder deletions failed', {
                    failures: failures.map(f => ({
                        folder: f.folder,
                        storageType: f.storageType,
                        error: f.error
                    }))
                });
            }
        } catch (error) {
            logger.error('Failed comprehensive folder deletion', {
                error: error instanceof Error ? error.message : String(error),
                fileId
            });
            throw error;
        }
    }

    /**
     * Check if a file exists in storage
     */
    public async fileExists(filePath: string, storageType: StorageType): Promise<boolean> {
        try {
            if (storageType === StorageType.SPACES) {
                return await spacesStorage.fileExists(filePath);
            } else {
                return fs.existsSync(filePath);
            }
        } catch (error) {
            logger.error('Failed to check file existence', {
                error: error instanceof Error ? error.message : String(error),
                filePath,
                storageType
            });
            return false;
        }
    }

    /**
     * Check if a file exists with fallback logic (try Spaces first, then local)
     */
    public async fileExistsWithFallback(filePath: string, preferredStorageType?: StorageType): Promise<{
        exists: boolean;
        storageType: StorageType;
        actualPath: string;
    }> {
        try {
            // If we have a preferred storage type, try that first
            if (preferredStorageType) {
                const exists = await this.fileExists(filePath, preferredStorageType);
                if (exists) {
                    return {
                        exists: true,
                        storageType: preferredStorageType,
                        actualPath: filePath
                    };
                }
            }

            // Try Spaces first (most likely for new files)
            const existsInSpaces = await this.fileExists(filePath, StorageType.SPACES);
            if (existsInSpaces) {
                logger.debug('File found in Spaces storage', { filePath });
                return {
                    exists: true,
                    storageType: StorageType.SPACES,
                    actualPath: filePath
                };
            }

            // Try local storage as fallback
            const existsLocally = await this.fileExists(filePath, StorageType.LOCAL);
            if (existsLocally) {
                logger.debug('File found in local storage', { filePath });
                return {
                    exists: true,
                    storageType: StorageType.LOCAL,
                    actualPath: filePath
                };
            }

            // File not found in either storage
            logger.debug('File not found in any storage', { filePath });
            return {
                exists: false,
                storageType: preferredStorageType || StorageType.LOCAL,
                actualPath: filePath
            };
        } catch (error) {
            logger.error('Error checking file existence with fallback', {
                error: error instanceof Error ? error.message : String(error),
                filePath,
                preferredStorageType
            });
            return {
                exists: false,
                storageType: preferredStorageType || StorageType.LOCAL,
                actualPath: filePath
            };
        }
    }

    /**
     * Get file URL for serving
     */
    public async getFileUrl(filePath: string, storageType: StorageType): Promise<string> {
        try {
            if (storageType === StorageType.SPACES) {
                // Generate presigned URL for private files
                return await spacesStorage.getPresignedUrl(filePath, 3600); // 1 hour expiry
            } else {
                // For local files, return the CDN URL
                const relativePath = path.relative(CDN_CONFIG.user_root, filePath);
                return `${CDN_CONFIG.baseUrl}/${relativePath}`;
            }
        } catch (error) {
            logger.error('Failed to get file URL', {
                error: error instanceof Error ? error.message : String(error),
                filePath,
                storageType
            });
            throw error;
        }
    }

    /**
     * Get local storage path for a file
     */
    private async getLocalStoragePath(
        fileId: string,
        filename: string,
        isZip = false
    ): Promise<string> {
        const storageRoot = await storageManager.getDrive();
        const subDir = isZip ? 'zips' : 'levels';
        return path.join(storageRoot, subDir, fileId, filename);
    }

    /**
     * Get storage statistics
     */
    public async getStorageStats(): Promise<{
        local: any;
        spaces: any;
        config: StorageConfig;
    }> {
        try {
            const [localStats, spacesStats] = await Promise.all([
                this.getLocalStorageStats(),
                this.getSpacesStorageStats()
            ]);

            return {
                local: localStats,
                spaces: spacesStats,
                config: this.config
            };
        } catch (error) {
            logger.error('Failed to get storage statistics', {
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    private async getLocalStorageStats(): Promise<any> {
        try {
            return storageManager.getDrivesStatus();
        } catch (error) {
            logger.warn('Failed to get local storage stats', {
                error: error instanceof Error ? error.message : String(error)
            });
            return null;
        }
    }

    private async getSpacesStorageStats(): Promise<any> {
        try {
            return await spacesStorage.getStorageStats();
        } catch (error) {
            logger.warn('Failed to get Spaces storage stats', {
                error: error instanceof Error ? error.message : String(error)
            });
            return null;
        }
    }

    /**
     * Migrate files from local storage to Spaces
     */
    public async migrateToSpaces(
        files: Array<{ localPath: string; key: string; contentType?: string }>
    ): Promise<Array<{ localPath: string; key: string; success: boolean; error?: string }>> {
        const results: Array<{ localPath: string; key: string; success: boolean; error?: string }> = [];

        for (const file of files) {
            try {
                await spacesStorage.uploadFile(file.localPath, file.key, file.contentType);
                results.push({ localPath: file.localPath, key: file.key, success: true });

                logger.debug('File migrated to Spaces', {
                    localPath: file.localPath,
                    key: file.key
                });
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                results.push({
                    localPath: file.localPath,
                    key: file.key,
                    success: false,
                    error: errorMessage
                });

                logger.error('Failed to migrate file to Spaces', {
                    localPath: file.localPath,
                    key: file.key,
                    error: errorMessage
                });
            }
        }

        return results;
    }
}

export const hybridStorageManager = HybridStorageManager.getInstance();
