import fs from 'fs';
import path from 'path';
import { logger } from '@/server/services/core/LoggerService.js';
import CdnFile from '@/models/cdn/CdnFile.js';
import { spacesStorage } from '../storage/spacesStorage.js';
import { listEntries as archiveListEntries, extractEntry as archiveExtractEntry } from '../archive/archiveService.js';

export function getTargetLevelMetadataEntry(metadata: any, targetLevelPath: string): any | null {
    const allLevelFiles = metadata?.allLevelFiles || [];
    const normalizedTargetPath = String(targetLevelPath).replace(/\\/g, '/').replace(/^\/+/, '');
    for (const levelFile of allLevelFiles) {
        const filePath = String(levelFile?.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
        const relativePath = String(levelFile?.relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (filePath === normalizedTargetPath || relativePath === normalizedTargetPath) {
            return levelFile;
        }
    }
    return null;
}

export async function downloadLevelToWorkspace(levelPath: string, join: (...parts: string[]) => string): Promise<{ localPath: string }> {
    const levelExists = await spacesStorage.fileExists(levelPath);
    if (!levelExists) {
        throw new Error(`Target level file not found in storage: ${levelPath}`);
    }

    const ext = path.extname(levelPath) || '.adofai';
    const tempPath = join(`level_${Date.now()}${ext}`);
    await spacesStorage.downloadFileToPathStreaming(levelPath, tempPath);

    return { localPath: tempPath };
}

/**
 * Download original .adofai bytes from Spaces (stored copy or zip) into the current workspace.
 */
export async function extractSourceCopyFromMetadata(params: {
    file: CdnFile;
    targetLevelPath: string;
    metadata: any;
    join: (...parts: string[]) => string;
}): Promise<{ localPath: string } | null> {
    const { file, targetLevelPath, metadata, join } = params;

    try {
        const targetLevelEntry = getTargetLevelMetadataEntry(metadata, targetLevelPath);

        if (targetLevelEntry?.sourceCopyPath) {
            const sourceCheck = await spacesStorage.fileExists(targetLevelEntry.sourceCopyPath);
            if (!sourceCheck) {
                throw new Error(`Source copy file not found in storage: ${targetLevelEntry.sourceCopyPath}`);
            }

            const ext = path.extname(String(targetLevelEntry.sourceCopyPath)) || '.adofai';
            const targetCopyPath = join(`source_copy${ext}`);
            await spacesStorage.downloadFileToPathStreaming(targetLevelEntry.sourceCopyPath, targetCopyPath);
            return { localPath: targetCopyPath };
        }

        const originalZip = metadata?.originalZip;
        if (!originalZip?.path) {
            logger.warn('No original zip path in metadata, cannot extract source copy', { fileId: file.id });
            return null;
        }

        const tempZipPath = join(`original_${Date.now()}.zip`);

        logger.debug('Downloading zip for source copy extraction', {
            fileId: file.id,
            zipPath: originalZip.path,
            tempZipPath
        });

        await spacesStorage.downloadFileToPathStreaming(originalZip.path, tempZipPath);

        const levelEntry = targetLevelEntry || getTargetLevelMetadataEntry(metadata, targetLevelPath);
        const targetLevelName: string = levelEntry?.name || path.basename(targetLevelPath);
        const targetRelativePath: string | null = levelEntry?.relativePath
            ? String(levelEntry.relativePath).replace(/\\/g, '/').replace(/^\/+/, '')
            : null;

        try {
            const entries = await archiveListEntries(tempZipPath);

            let foundEntry: typeof entries[number] | null = null;
            if (targetRelativePath) {
                foundEntry = entries.find((entry) => entry.relativePath === targetRelativePath) || null;
            }
            if (!foundEntry) {
                for (const entry of entries) {
                    if (entry.isDirectory) continue;
                    if (entry.name === targetLevelName || entry.relativePath.endsWith(targetLevelName)) {
                        foundEntry = entry;
                        break;
                    }
                }
            }

            if (!foundEntry) {
                logger.warn('Target level file not found in archive', {
                    fileId: file.id,
                    targetLevelName,
                    availableEntries: entries.map((e) => e.name)
                });
                return null;
            }

            const extractedPath = join(`extracted_${Date.now()}.adofai`);
            await archiveExtractEntry(tempZipPath, foundEntry, extractedPath);

            let extractedSize = 0;
            try {
                extractedSize = (await fs.promises.stat(extractedPath)).size;
            } catch {
                /* size logging is best-effort */
            }

            logger.debug('Source copy extracted successfully', {
                fileId: file.id,
                extractedPath,
                size: extractedSize
            });

            return { localPath: extractedPath };
        } finally {
            await fs.promises.unlink(tempZipPath).catch(() => Promise.resolve());
        }
    } catch (error) {
        logger.error('Failed to extract source copy', {
            fileId: file.id,
            error: error instanceof Error ? error.message : String(error)
        });
        return null;
    }
}

