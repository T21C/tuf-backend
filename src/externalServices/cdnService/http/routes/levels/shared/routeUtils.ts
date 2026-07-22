import path from 'path';
import { normalizeLevelzipMetadata } from '@/externalServices/cdnService/domain/metadata/normalizeLevelzipMetadata.js';
import {
    ArchivePathError,
    normalizeRelativePath
} from '@/externalServices/cdnService/domain/archive/ingestPaths.js';
import { matchLevelFileBySelection } from '@/externalServices/cdnService/domain/level/matchLevelFileSelection.js';
import { spacesStorage } from '@/externalServices/cdnService/infra/storage/spacesStorage.js';

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

/** Parse a client-supplied archive-relative path; throws {@link ArchivePathError} on traversal. */
export function parseClientRelativePath(raw: unknown): string {
    if (typeof raw !== 'string' || raw.trim() === '') {
        throw new ArchivePathError('Path is required');
    }
    return normalizeRelativePath(raw);
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

export type LevelZipChartContent = {
    name: string;
    relativePath: string;
    size: number;
    isTarget: boolean;
    storagePath: string;
    url: string;
};

export type LevelZipSongContent = {
    name: string;
    relativePath?: string;
    size: number;
    type?: string;
    storagePath: string;
    url: string;
};

export type LevelZipFileContents = {
    charts: LevelZipChartContent[];
    songs: LevelZipSongContent[];
};

type ChartMetaEntry = {
    name?: string;
    relativePath?: string;
    path?: string;
    size?: number;
};

type SongMetaEntry = {
    name?: string;
    relativePath?: string;
    path?: string;
    size?: number;
    type?: string;
};

function chartRelativePath(entry: ChartMetaEntry): string {
    if (typeof entry.relativePath === 'string' && entry.relativePath.length > 0) {
        return posixNorm(entry.relativePath);
    }
    if (typeof entry.name === 'string' && entry.name.length > 0) {
        return posixNorm(entry.name);
    }
    if (typeof entry.path === 'string' && entry.path.length > 0) {
        return path.posix.basename(posixNorm(entry.path));
    }
    return '';
}

function isTargetChart(
    entry: ChartMetaEntry,
    targetLevel: string | null | undefined,
    targetLevelRelativePath: string | null | undefined
): boolean {
    const rel = chartRelativePath(entry);
    const storagePath = typeof entry.path === 'string' ? posixNorm(entry.path) : '';
    if (typeof targetLevel === 'string' && targetLevel.length > 0) {
        const tgt = posixNorm(targetLevel);
        if (storagePath === tgt || rel === tgt || storagePath.endsWith(`/${tgt}`) || rel.endsWith(`/${tgt}`)) {
            return true;
        }
    }
    if (typeof targetLevelRelativePath === 'string' && targetLevelRelativePath.length > 0) {
        const tgtRel = posixNorm(targetLevelRelativePath);
        if (rel === tgtRel || storagePath.endsWith(`/${tgtRel}`)) {
            return true;
        }
    }
    return false;
}

/**
 * Build a public contents manifest from LEVELZIP metadata (no R2 listing / re-extract).
 */
export function buildLevelZipFileContents(metadata: unknown): LevelZipFileContents {
    const raw =
        metadata && typeof metadata === 'object' && !Array.isArray(metadata)
            ? (metadata as Record<string, unknown>)
            : {};

    const targetLevel = typeof raw.targetLevel === 'string' ? raw.targetLevel : null;
    const targetLevelRelativePath =
        typeof raw.targetLevelRelativePath === 'string' ? raw.targetLevelRelativePath : null;

    const charts: LevelZipChartContent[] = [];
    const levelEntries = recordOrArrayValues<ChartMetaEntry>(raw.allLevelFiles);
    for (const entry of levelEntries) {
        if (typeof entry.path !== 'string' || entry.path.length === 0) {
            continue;
        }
        const relativePath = chartRelativePath(entry);
        const name =
            (typeof entry.name === 'string' && entry.name) ||
            (relativePath ? path.posix.basename(relativePath) : path.posix.basename(entry.path));
        charts.push({
            name,
            relativePath,
            size: typeof entry.size === 'number' && !Number.isNaN(entry.size) ? entry.size : 0,
            isTarget: isTargetChart(entry, targetLevel, targetLevelRelativePath),
            storagePath: entry.path,
            url: spacesStorage.getFileUrl(entry.path)
        });
    }

    const songs: LevelZipSongContent[] = [];
    const songFiles = raw.songFiles;
    if (songFiles && typeof songFiles === 'object' && !Array.isArray(songFiles)) {
        for (const [key, value] of Object.entries(songFiles as Record<string, SongMetaEntry>)) {
            if (!value || typeof value !== 'object') {
                continue;
            }
            if (typeof value.path !== 'string' || value.path.length === 0) {
                continue;
            }
            const keyNorm = posixNorm(key);
            const relativePath =
                typeof value.relativePath === 'string' && value.relativePath.length > 0
                    ? posixNorm(value.relativePath)
                    : keyNorm.includes('/')
                      ? keyNorm
                      : undefined;
            const name =
                (typeof value.name === 'string' && value.name) ||
                (relativePath ? path.posix.basename(relativePath) : path.posix.basename(keyNorm));
            songs.push({
                name,
                ...(relativePath ? { relativePath } : {}),
                size: typeof value.size === 'number' && !Number.isNaN(value.size) ? value.size : 0,
                ...(typeof value.type === 'string' && value.type ? { type: value.type } : {}),
                storagePath: value.path,
                url: spacesStorage.getFileUrl(value.path)
            });
        }
    }

    return { charts, songs };
}

/**
 * Allowlist a client chart path against `allLevelFiles` (relative path, storage key, or unique basename).
 */
export function resolveChartStoragePathFromMetadata(
    metadata: unknown,
    selectionPath: string
): string | null {
    const raw =
        metadata && typeof metadata === 'object' && !Array.isArray(metadata)
            ? (metadata as Record<string, unknown>)
            : {};
    const entries = recordOrArrayValues<ChartMetaEntry>(raw.allLevelFiles).filter(
        (e) => typeof e.path === 'string' && e.path.length > 0
    );
    const matched = matchLevelFileBySelection(entries, selectionPath);
    return matched?.path ?? null;
}

function attachPublicObjectUrls(metadata: Record<string, unknown>): void {
    const alf = metadata.allLevelFiles;
    if (Array.isArray(alf)) {
        for (const item of alf) {
            if (item && typeof item === 'object' && !Array.isArray(item)) {
                const entry = item as Record<string, unknown>;
                if (typeof entry.path === 'string' && entry.path.length > 0) {
                    entry.url = spacesStorage.getFileUrl(entry.path);
                }
            }
        }
    }

    const sf = metadata.songFiles;
    if (sf && typeof sf === 'object' && !Array.isArray(sf)) {
        for (const value of Object.values(sf as Record<string, unknown>)) {
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                const entry = value as Record<string, unknown>;
                if (typeof entry.path === 'string' && entry.path.length > 0) {
                    entry.url = spacesStorage.getFileUrl(entry.path);
                }
            }
        }
    }
}

/**
 * Full normalized LEVELZIP metadata for main-API `cdnData` and `POST /levels/bulk-metadata`:
 * canonical keys from {@link normalizeLevelzipMetadata}, optional derived `targetLevel*`,
 * public object `url`s on charts/songs, and `transformUnavailable` for download UI parity.
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

    attachPublicObjectUrls(out);

    out.transformUnavailable = !!raw.targetLevelOversized;
    return out;
}

/** @deprecated Use {@link buildPublicLevelzipCdnMetadata}; kept as an alias for the same shape. */
export function extractLevelMetadata(metadata: any): Record<string, unknown> {
    return buildPublicLevelzipCdnMetadata(metadata);
}

