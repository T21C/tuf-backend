import fs from 'fs';

export class PackDiskFullError extends Error {
    readonly code = 'PACK_DISK_FULL';

    constructor(message = 'Not enough temporary disk space for this pack download') {
        super(message);
        this.name = 'PackDiskFullError';
    }
}

export class PackQueueBusyError extends Error {
    readonly code = 'PACK_QUEUE_BUSY';

    constructor(message = 'Server is preparing other pack downloads; try again later') {
        super(message);
        this.name = 'PackQueueBusyError';
    }
}

type StatFsLike = {
    bsize: number;
    bavail: number;
};

export async function getVolumeFreeBytes(targetPath: string): Promise<number | null> {
    try {
        const statfs = (fs.promises as typeof fs.promises & {
            statfs?: (path: string) => Promise<StatFsLike>;
        }).statfs;
        if (typeof statfs !== 'function') {
            return null;
        }
        const stats = await statfs(targetPath);
        return stats.bsize * stats.bavail;
    } catch {
        return null;
    }
}

export async function assertPackDiskHeadroom(
    packDownloadDir: string,
    requiredBytes: number,
    minFreeBytes: number,
): Promise<void> {
    const freeBytes = await getVolumeFreeBytes(packDownloadDir);
    if (freeBytes === null) {
        return;
    }

    const needed = requiredBytes + minFreeBytes;
    if (freeBytes < needed) {
        throw new PackDiskFullError(
            `Not enough temporary disk space for this pack (need ~${formatGiB(needed)}, have ~${formatGiB(freeBytes)} free)`,
        );
    }
}

export function isEnospcError(error: unknown): boolean {
    if (!error) {
        return false;
    }
    const errnoError = error as NodeJS.ErrnoException;
    if (errnoError.code === 'ENOSPC') {
        return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('errno=28') || message.includes('No space left on device');
}

export function toPackDownloadFailure(error: unknown): { message: string; code: string } {
    if (error instanceof PackDiskFullError || isEnospcError(error)) {
        return {
            message: error instanceof Error ? error.message : 'Not enough temporary disk space for this pack download',
            code: 'PACK_DISK_FULL',
        };
    }
    if (error instanceof PackQueueBusyError) {
        return { message: error.message, code: error.code };
    }
    return {
        message: error instanceof Error ? error.message : String(error),
        code: 'PACK_DOWNLOAD_ERROR',
    };
}

function formatGiB(bytes: number): string {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}
