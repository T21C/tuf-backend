import fs from 'fs';
import path from 'path';

export class ArchivePathError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ArchivePathError';
    }
}

function assertPathUnderRoot(root: string, target: string): void {
    const rootResolved = path.resolve(root);
    const targetResolved = path.resolve(target);
    const rootWithSep = rootResolved.endsWith(path.sep) ? rootResolved : `${rootResolved}${path.sep}`;
    if (targetResolved !== rootResolved && !targetResolved.startsWith(rootWithSep)) {
        throw new ArchivePathError(`Path escapes extract root: ${target}`);
    }
}

/**
 * Normalise an archive-internal relative path and reject zip-slip segments (`..`, `.`).
 */
export function normalizeRelativePath(relativePath: string): string {
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized) {
        throw new ArchivePathError('Empty archive relative path');
    }

    const parts = normalized.split('/');
    for (const part of parts) {
        if (part === '..' || part === '.') {
            throw new ArchivePathError(`Archive path traversal segment rejected: ${relativePath}`);
        }
    }

    return normalized;
}

/** Storage/metadata suffix for the byte-for-byte archive extract (never LevelDict output). */
export function toSourceRelativePath(relativePath: string): string {
    const normalized = normalizeRelativePath(relativePath);
    const parsed = path.posix.parse(normalized);
    return path.posix.join(parsed.dir, `${parsed.name}.source`);
}

/** @deprecated Legacy uploads used `.copy` beside the canonical level object. */
export function toCopyRelativePath(relativePath: string): string {
    const normalized = normalizeRelativePath(relativePath);
    const parsed = path.posix.parse(normalized);
    return path.posix.join(parsed.dir, `${parsed.name}.copy`);
}

/**
 * Snapshot extracted level bytes before any LevelDict parse or canonical rewrite.
 * The returned path must only ever be read for upload as the immutable source object.
 */
export async function snapshotLevelSourceBytes(
    extractedLevelPath: string,
    extractRoot: string,
    relativePath: string
): Promise<{ sourceLocalPath: string; sourceRelativePath: string }> {
    const sourceRelativePath = toSourceRelativePath(relativePath);
    const sourceLocalPath = path.join(extractRoot, sourceRelativePath);
    assertPathUnderRoot(extractRoot, sourceLocalPath);
    assertPathUnderRoot(extractRoot, extractedLevelPath);
    await fs.promises.mkdir(path.dirname(sourceLocalPath), { recursive: true });
    await fs.promises.copyFile(extractedLevelPath, sourceLocalPath);
    return { sourceLocalPath, sourceRelativePath };
}
