import path from 'path';

export function normalizeRelativePath(relativePath: string): string {
    return relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
}

export function toCopyRelativePath(relativePath: string): string {
    const normalized = normalizeRelativePath(relativePath);
    const parsed = path.posix.parse(normalized);
    return path.posix.join(parsed.dir, `${parsed.name}.copy`);
}
