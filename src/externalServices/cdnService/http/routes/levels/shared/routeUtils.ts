import path from 'path';
import { normalizeLevelzipMetadata } from '@/externalServices/cdnService/domain/metadata/normalizeLevelzipMetadata.js';

export function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[<>:"\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .substring(0, 255);
}

export function encodeContentDisposition(filename: string): string {
  const sanitized = sanitizeFilename(filename);
  const encoded = encodeURIComponent(sanitized);
  return `attachment; filename*=UTF-8''${encoded}`;
}

export function posixNorm(p: string): string {
    return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * Resolve a chart's `songFilename` to stored CDN song metadata. Keys may be basename-only (legacy)
 * or archive-relative paths (disambiguates duplicate basenames in nested folders).
 */
export function resolveSongFileForTransform(
    songFiles: Record<string, { name: string; path: string; size: number; type: string }>,
    songFilename: string | undefined,
    targetLevelRelativePath: string | undefined
): { name: string; path: string; size: number; type: string } | undefined {
    if (!songFiles || songFilename === undefined || songFilename === '') {
        return undefined;
    }
    const normSong = posixNorm(songFilename);
    const hitExact = songFiles[normSong] ?? songFiles[songFilename];
    if (hitExact) {
        return hitExact;
    }

    const tgt = targetLevelRelativePath ? posixNorm(targetLevelRelativePath) : '';
    const levelDir = tgt ? path.posix.dirname(tgt) : '';

    if (normSong.includes('/') && !normSong.startsWith('..')) {
        const hit = songFiles[normSong];
        if (hit) {
            return hit;
        }
    } else if (levelDir && levelDir !== '.' && levelDir !== '') {
        const nextToLevel = `${levelDir}/${path.posix.basename(normSong)}`;
        const hit2 = songFiles[nextToLevel];
        if (hit2) {
            return hit2;
        }
    }

    const wantBase = path.posix.basename(normSong);
    let fallback: { name: string; path: string; size: number; type: string } | undefined;
    for (const [key, song] of Object.entries(songFiles)) {
        const keyNorm = posixNorm(key);
        if (path.posix.basename(keyNorm) !== wantBase) {
            continue;
        }
        if (levelDir && path.posix.dirname(keyNorm) === levelDir) {
            return song;
        }
        if (!fallback) {
            fallback = song;
        }
    }
    return fallback;
}

/** `songFiles` / legacy maps are records; `allLevelFiles` may be a record or a plain array. */
function recordOrArrayValues<T>(v: unknown): T[] {
    if (v == null) {
        return [];
    }
    if (Array.isArray(v)) {
        return v as T[];
    }
    if (typeof v === 'object') {
        return Object.values(v as Record<string, T>);
    }
    return [];
}

type RawLevelFileish = {
    path?: string;
    size?: number;
    relativePath?: string;
};

function collectRawLevelFileEntries(raw: Record<string, unknown>): RawLevelFileish[] {
    const out: RawLevelFileish[] = [];
    const alf = raw.allLevelFiles;
    if (Array.isArray(alf)) {
        for (const item of alf) {
            if (item && typeof item === 'object') {
                out.push(item as RawLevelFileish);
            }
        }
    } else if (alf && typeof alf === 'object') {
        out.push(...Object.values(alf as Record<string, RawLevelFileish>));
    }
    const lf = raw.levelFiles;
    if (lf && typeof lf === 'object' && !Array.isArray(lf)) {
        out.push(...Object.values(lf as Record<string, RawLevelFileish>));
    }
    return out;
}

/** Pick largest level file by `size` when `targetLevel` is not set (matches transform route heuristic). */
export function deriveLargestLevelFromRaw(raw: Record<string, unknown>): { path: string; relativePath?: string } | null {
    const entries = collectRawLevelFileEntries(raw).filter(
        (e) => typeof e.path === 'string' && e.path.length > 0 && typeof e.size === 'number' && !Number.isNaN(e.size)
    );
    if (entries.length === 0) {
        return null;
    }
    const largest = entries.reduce((a, b) => (Number(b.size) > Number(a.size) ? b : a));
    const rel =
        typeof largest.relativePath === 'string' && largest.relativePath.length > 0
            ? largest.relativePath
            : undefined;
    return { path: largest.path!, relativePath: rel };
}

/**
 * Full normalized LEVELZIP metadata for main-API `cdnData` and `POST /levels/bulk-metadata`:
 * canonical keys from {@link normalizeLevelzipMetadata}, optional derived `targetLevel*`,
 * and `transformUnavailable` for download UI parity with the legacy trimmed payload.
 */
export function buildPublicLevelzipCdnMetadata(metadata: unknown): Record<string, unknown> {
    const raw =
        metadata && typeof metadata === 'object' && !Array.isArray(metadata)
            ? (metadata as Record<string, unknown>)
            : {};

    const { normalized } = normalizeLevelzipMetadata(metadata);
    const out: Record<string, unknown> = { ...normalized };

    const hasTarget =
        (typeof out.targetLevel === 'string' && out.targetLevel.length > 0) ||
        (typeof out.targetLevelRelativePath === 'string' && out.targetLevelRelativePath.length > 0);

    if (!hasTarget) {
        const derived = deriveLargestLevelFromRaw(raw);
        if (derived?.path) {
            out.targetLevel = derived.path;
            if (derived.relativePath) {
                out.targetLevelRelativePath = derived.relativePath;
            }
        }
    }

    out.transformUnavailable = !!raw.targetLevelOversized;
    return out;
}

/** @deprecated Use {@link buildPublicLevelzipCdnMetadata}; kept as an alias for the same shape. */
export function extractLevelMetadata(metadata: any): Record<string, unknown> {
    return buildPublicLevelzipCdnMetadata(metadata);
}

