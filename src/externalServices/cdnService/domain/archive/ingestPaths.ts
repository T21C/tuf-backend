import fs from 'fs';
import path from 'path';

export function normalizeRelativePath(relativePath: string): string {
    return relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
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
    await fs.promises.mkdir(path.dirname(sourceLocalPath), { recursive: true });
    await fs.promises.copyFile(extractedLevelPath, sourceLocalPath);
    return { sourceLocalPath, sourceRelativePath };
}
