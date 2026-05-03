/**
 * Canonical subset of persisted LEVELZIP `CdnFile.metadata` used by the CDN service.
 *
 * Strips migration-era paths, duplicate storage hints, and upload-time-only fields
 * while preserving everything referenced by:
 * - {@link ../infra/level/levelSourceBytes.ts} (sourceCopyPath, originalZip.path, allLevelFiles paths)
 * - transform / levelData / chart routes (songFiles, targetLevel*, allLevelFiles)
 * - {@link ../infra/archive/archiveService.ts} getOriginalArchiveMeta (originalArchive / originalZip)
 * - {@link ../domain/level/levelCacheSignature.ts} (targetSafeToParse*)
 */

/** Per-entry fields on `allLevelFiles[]` / `levelFiles` values still read at runtime. */
const LEVEL_FILE_ENTRY_KEYS = new Set([
    'name',
    'relativePath',
    'path',
    'size',
    'sourceCopyPath',
    'sourceCopyRelativePath',
    'sourceCopyStorageType',
    'hasYouTubeStream',
    'songFilename',
    'oversizedUnparsed',
    'artist',
    'song',
    'author',
    'difficulty',
    'bpm',
]);

const SONG_ENTRY_KEYS = new Set(['name', 'path', 'size', 'type']);

const ARCHIVE_DESCRIPTOR_KEYS = new Set([
    'name',
    'path',
    'size',
    'originalFilename',
    'format',
    'contentType',
    'extension',
]);

function pick<T extends Record<string, unknown>>(obj: T, allowed: Set<string>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) {
        if (allowed.has(k)) {
            out[k] = obj[k];
        }
    }
    return out;
}

function trimArchiveDescriptor(raw: unknown): Record<string, unknown> | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    return pick(raw as Record<string, unknown>, ARCHIVE_DESCRIPTOR_KEYS);
}

function trimLevelFileEntry(entry: unknown): Record<string, unknown> | null {
    if (!entry || typeof entry !== 'object') {
        return null;
    }
    return pick(entry as Record<string, unknown>, LEVEL_FILE_ENTRY_KEYS);
}

function trimSongEntry(entry: unknown): Record<string, unknown> | null {
    if (!entry || typeof entry !== 'object') {
        return null;
    }
    return pick(entry as Record<string, unknown>, SONG_ENTRY_KEYS);
}

function trimLevelFilesMap(raw: unknown): Record<string, Record<string, unknown>> | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return undefined;
    }
    const out: Record<string, Record<string, unknown>> = {};
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
        const trimmed = trimLevelFileEntry(val);
        if (trimmed && Object.keys(trimmed).length > 0) {
            out[key] = trimmed;
        }
    }
    return out;
}

function trimAllLevelFiles(raw: unknown): Record<string, unknown>[] | undefined {
    if (!Array.isArray(raw)) {
        return undefined;
    }
    const out: Record<string, unknown>[] = [];
    for (const item of raw) {
        const trimmed = trimLevelFileEntry(item);
        if (trimmed && Object.keys(trimmed).length > 0) {
            out.push(trimmed);
        }
    }
    // Preserve explicit empty array (callers test `.length === 0`).
    return out;
}

function trimSongFiles(raw: unknown): Record<string, Record<string, unknown>> | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return undefined;
    }
    const out: Record<string, Record<string, unknown>> = {};
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
        const trimmed = trimSongEntry(val);
        if (trimmed && Object.keys(trimmed).length > 0) {
            out[key] = trimmed;
        }
    }
    return out;
}

export type NormalizeLevelzipMetadataResult = {
    /** Plain object safe to pass to `CdnFile.update({ metadata })` (always a new object). */
    normalized: Record<string, unknown>;
    changed: boolean;
    /** Approximate byte reduction of JSON.stringify (UTF-16 length not measured). */
    bytesSavedEstimate: number;
};

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((v) => stableStringify(v)).join(',')}]`;
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * Returns a new metadata object with deprecated / redundant keys removed.
 * Does not mutate the input.
 */
export function normalizeLevelzipMetadata(metadata: unknown): NormalizeLevelzipMetadataResult {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return { normalized: {}, changed: false, bytesSavedEstimate: 0 };
    }

    const src = metadata as Record<string, unknown>;
    const before = stableStringify(src);

    const arch = trimArchiveDescriptor(src.originalArchive) ?? trimArchiveDescriptor(src.originalZip);
    const zipMirror = arch ? { ...arch } : null;

    const normalized: Record<string, unknown> = {};

    if (src.levelFiles !== undefined) {
        const lf = trimLevelFilesMap(src.levelFiles);
        if (lf && Object.keys(lf).length > 0) {
            normalized.levelFiles = lf;
        }
    }
    if (src.allLevelFiles !== undefined) {
        const alf = trimAllLevelFiles(src.allLevelFiles);
        if (alf !== undefined) {
            normalized.allLevelFiles = alf;
        }
    }
    if (src.songFiles !== undefined) {
        const sf = trimSongFiles(src.songFiles);
        if (sf !== undefined && Object.keys(sf).length > 0) {
            normalized.songFiles = sf;
        }
    }

    if (src.targetLevel !== undefined && src.targetLevel !== null) {
        normalized.targetLevel = src.targetLevel;
    }
    if (src.targetLevelRelativePath !== undefined && src.targetLevelRelativePath !== null) {
        normalized.targetLevelRelativePath = src.targetLevelRelativePath;
    }
    if (src.targetLevelOversized !== undefined) {
        normalized.targetLevelOversized = src.targetLevelOversized;
    }
    if (src.pathConfirmed !== undefined) {
        normalized.pathConfirmed = src.pathConfirmed;
    }

    if (arch) {
        normalized.originalArchive = { ...arch };
    }
    if (zipMirror) {
        normalized.originalZip = { ...zipMirror };
    }

    if (src.uploadedAt !== undefined) {
        normalized.uploadedAt = src.uploadedAt;
    }
    if (src.targetSafeToParse !== undefined) {
        normalized.targetSafeToParse = src.targetSafeToParse;
    }
    if (src.targetSafeToParseVersion !== undefined) {
        normalized.targetSafeToParseVersion = src.targetSafeToParseVersion;
    }

    const after = stableStringify(normalized);
    const changed = before !== after;
    const bytesSavedEstimate = changed ? before.length - after.length : 0;

    return {
        normalized,
        changed,
        bytesSavedEstimate,
    };
}

/** Top-level keys present on the input but absent on the normalized output (for logging). */
export function listRemovedTopLevelKeys(metadata: unknown): string[] {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return [];
    }
    const src = metadata as Record<string, unknown>;
    const { normalized } = normalizeLevelzipMetadata(metadata);
    const kept = new Set(Object.keys(normalized));
    return Object.keys(src).filter((k) => !kept.has(k));
}
