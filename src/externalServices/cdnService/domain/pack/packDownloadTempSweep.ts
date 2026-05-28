import fs from 'fs';
import path from 'path';
import { logger } from '@/server/services/core/LoggerService.js';

export type PackTempSweepResult = {
    removedDirs: number;
    removedFiles: number;
};

/**
 * Removes stale pack-download workspaces under `tempDir` and orphaned `.zip` files
 * directly under `packDownloadDir` (failed jobs that never uploaded to Spaces).
 */
export async function sweepOrphanedPackDownloadArtifacts(
    packDownloadDir: string,
    tempDir: string,
    maxAgeMs: number,
): Promise<PackTempSweepResult> {
    const result: PackTempSweepResult = { removedDirs: 0, removedFiles: 0 };
    const cutoff = Date.now() - maxAgeMs;

    await sweepTempWorkspaceDirs(tempDir, cutoff, result);
    await sweepStaleLocalPackZips(packDownloadDir, cutoff, result);

    if (result.removedDirs > 0 || result.removedFiles > 0) {
        logger.info('Pack download disk sweep removed stale artifacts', {
            packDownloadDir,
            tempDir,
            maxAgeMs,
            ...result,
        });
    }

    return result;
}

async function sweepTempWorkspaceDirs(
    tempDir: string,
    cutoffMs: number,
    result: PackTempSweepResult,
): Promise<void> {
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(tempDir, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return;
        }
        throw error;
    }

    await Promise.all(entries.map(async (entry) => {
        if (!entry.isDirectory()) {
            return;
        }
        const dirPath = path.join(tempDir, entry.name);
        try {
            const stat = await fs.promises.stat(dirPath);
            if (stat.mtimeMs > cutoffMs) {
                return;
            }
            await fs.promises.rm(dirPath, { recursive: true, force: true });
            result.removedDirs += 1;
        } catch (error) {
            logger.warn('Pack download temp sweep failed for directory', {
                dirPath,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }));
}

async function sweepStaleLocalPackZips(
    packDownloadDir: string,
    cutoffMs: number,
    result: PackTempSweepResult,
): Promise<void> {
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(packDownloadDir, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return;
        }
        throw error;
    }

    await Promise.all(entries.map(async (entry) => {
        if (!entry.isFile() || !entry.name.endsWith('.zip')) {
            return;
        }
        const filePath = path.join(packDownloadDir, entry.name);
        try {
            const stat = await fs.promises.stat(filePath);
            if (stat.mtimeMs > cutoffMs) {
                return;
            }
            await fs.promises.rm(filePath, { force: true });
            result.removedFiles += 1;
        } catch (error) {
            logger.warn('Pack download temp sweep failed for zip file', {
                filePath,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }));
}
