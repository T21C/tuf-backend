import { logger } from '@/server/services/core/LoggerService.js';
import { listEntries as archiveListEntries, type ArchiveEntry } from '../../infra/archive/archiveService.js';

export async function listArchiveEntriesForIngest(archiveFilePath: string, signal?: AbortSignal): Promise<ArchiveEntry[]> {
    const entries = await archiveListEntries(archiveFilePath, signal);

    /*
    logger.debug('Listed archive entries:', {
        archiveFilePath,
        entryCount: entries.length,
        entries: entries.map(entry => ({
            name: entry.name,
            size: entry.size,
            isDirectory: entry.isDirectory
        }))
    });
    */
    return entries;
}
