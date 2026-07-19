import { Op } from 'sequelize';

import CdnFile from '@/models/cdn/CdnFile.js';
import Level from '@/models/levels/Level.js';
import { deriveLargestLevelFromRaw } from '../../http/routes/levels/shared/routeUtils.js';
import { matchLevelFileBySelection } from './matchLevelFileSelection.js';
import {
    MAX_LEVEL_FILE_SIZE_FOR_PARSE,
    MAX_LEVEL_TILECOUNT_FOR_FULL_PARSE,
} from './levelParseLimits.js';

export type LevelFileEntry = {
    name?: string;
    path?: string;
    size?: number;
    relativePath?: string;
    oversizedUnparsed?: boolean;
};

export type LevelzipMetadata = {
    targetLevel?: string | null;
    targetLevelRelativePath?: string | null;
    targetLevelOversized?: boolean;
    targetSafeToParse?: boolean;
    targetSafeToParseVersion?: number;
    songFiles?: Record<string, unknown>;
    allLevelFiles?: LevelFileEntry[] | Record<string, LevelFileEntry>;
    levelFiles?: Record<string, LevelFileEntry>;
};

export type TransformExposureReason =
    | 'metadata_mismatch_oversized_unparsed'
    | 'metadata_size_over_parse_limit'
    | 'cache_tilecount_over_parse_limit'
    | 'legacy_safe_to_parse_on_oversized'
    | 'spaces_size_over_parse_limit'
    | 'spaces_size_unknown';

export type TransformExposureHit = {
    fileId: string;
    transformGateOpen: boolean;
    crashRisk: boolean;
    severity: 'critical' | 'high' | 'medium' | 'low' | 'none';
    reasons: TransformExposureReason[];
    targetLevel: string | null;
    targetLevelName: string | null;
    targetLevelOversized: boolean;
    targetOversizedUnparsed: boolean;
    metadataTargetSizeBytes: number | null;
    spacesTargetSizeBytes: number | null;
    cacheTilecount: number | null;
    targetSafeToParse: boolean;
    hasSongFiles: boolean;
    levelIds?: number[];
};

export type TransformExposureScanOptions = {
    fileId?: string | null;
    offset?: number;
    limit?: number | null;
    batchSize?: number;
    onlyExposed?: boolean;
    minFileSizeBytes?: number;
    minTilecount?: number;
    verifySpaces?: boolean;
    withLevelIds?: boolean;
    getSpacesTargetSizeBytes?: (targetPath: string) => Promise<number | null>;
};

export type TransformExposureScanSummary = {
    scanned: number;
    transformGateOpenCount: number;
    crashRiskCount: number;
    limits: {
        maxLevelFileSizeForParse: number;
        maxLevelTilecountForFullParse: number;
        auditMinFileSizeBytes: number;
        auditMinTilecount: number;
    };
    bySeverity: Record<string, number>;
    byReason: Record<string, number>;
    hits: TransformExposureHit[];
    exposedOnly: boolean;
    verifySpaces: boolean;
};

export function collectLevelEntries(metadata: LevelzipMetadata): LevelFileEntry[] {
    const out: LevelFileEntry[] = [];
    const push = (v: unknown) => {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            out.push(v as LevelFileEntry);
        }
    };
    const alf = metadata.allLevelFiles;
    if (Array.isArray(alf)) {
        for (const e of alf) push(e);
    } else if (alf && typeof alf === 'object') {
        for (const e of Object.values(alf)) push(e);
    }
    const lf = metadata.levelFiles;
    if (lf && typeof lf === 'object') {
        for (const e of Object.values(lf)) push(e);
    }
    return out;
}

export function resolveTransformTarget(metadata: LevelzipMetadata): {
    path: string | null;
    name: string | null;
    entry: LevelFileEntry | null;
} {
    let path =
        typeof metadata.targetLevel === 'string' && metadata.targetLevel.length > 0
            ? metadata.targetLevel
            : null;

    if (!path) {
        const derived = deriveLargestLevelFromRaw(metadata as Record<string, unknown>);
        path = derived?.path ?? null;
    }

    if (!path) {
        return { path: null, name: null, entry: null };
    }

    const entries = collectLevelEntries(metadata);
    const entry = matchLevelFileBySelection(entries, path);

    const name =
        (typeof entry?.name === 'string' && entry.name) ||
        path.split('/').pop() ||
        null;

    return { path, name, entry };
}

function parseCacheTilecount(cacheData: string | null): number | null {
    if (!cacheData) return null;
    try {
        const parsed = JSON.parse(cacheData) as { tilecount?: unknown };
        const tc = parsed?.tilecount;
        return typeof tc === 'number' && Number.isFinite(tc) ? tc : null;
    } catch {
        return null;
    }
}

/** Mirrors transform route: oversized levels are blocked only when `targetLevelOversized === true`. */
export function evaluateTransformOversizeExposure(
    file: Pick<CdnFile, 'id' | 'metadata' | 'cacheData'>,
    options: {
        minFileSizeBytes?: number;
        minTilecount?: number;
        spacesTargetSizeBytes?: number | null;
        spacesChecked?: boolean;
    } = {}
): TransformExposureHit {
    const minFileSizeBytes = options.minFileSizeBytes ?? MAX_LEVEL_FILE_SIZE_FOR_PARSE;
    const minTilecount = options.minTilecount ?? MAX_LEVEL_TILECOUNT_FOR_FULL_PARSE;

    const metadata = (file.metadata || {}) as LevelzipMetadata;
    const targetLevelOversized = metadata.targetLevelOversized === true;
    const transformGateOpen = !targetLevelOversized;
    const hasSongFiles =
        !!metadata.songFiles &&
        typeof metadata.songFiles === 'object' &&
        Object.keys(metadata.songFiles).length > 0;

    const { path: targetLevel, name: targetLevelName, entry } = resolveTransformTarget(metadata);
    const metadataTargetSizeBytes =
        typeof entry?.size === 'number' && Number.isFinite(entry.size) ? entry.size : null;
    const targetOversizedUnparsed = entry?.oversizedUnparsed === true;
    const cacheTilecount = parseCacheTilecount(file.cacheData);
    const targetSafeToParse = metadata.targetSafeToParse === true;

    const reasons: TransformExposureReason[] = [];

    if (targetOversizedUnparsed && !targetLevelOversized) {
        reasons.push('metadata_mismatch_oversized_unparsed');
    }
    if (metadataTargetSizeBytes !== null && metadataTargetSizeBytes > minFileSizeBytes) {
        reasons.push('metadata_size_over_parse_limit');
    }
    if (cacheTilecount !== null && cacheTilecount > minTilecount) {
        reasons.push('cache_tilecount_over_parse_limit');
    }
    if (
        targetSafeToParse &&
        (reasons.includes('metadata_size_over_parse_limit') ||
            reasons.includes('cache_tilecount_over_parse_limit') ||
            targetOversizedUnparsed)
    ) {
        reasons.push('legacy_safe_to_parse_on_oversized');
    }

    const spacesChecked = options.spacesChecked === true;
    const spacesSize = options.spacesTargetSizeBytes;
    if (spacesChecked && spacesSize != null && spacesSize > minFileSizeBytes) {
        reasons.push('spaces_size_over_parse_limit');
    }
    if (spacesChecked && targetLevel && (spacesSize == null || spacesSize === undefined)) {
        reasons.push('spaces_size_unknown');
    }

    const canReachParse = transformGateOpen && hasSongFiles && !!targetLevel;
    const crashRisk = canReachParse && reasons.length > 0;

    let severity: TransformExposureHit['severity'] = 'none';
    if (crashRisk) {
        const sizeBytes = Math.max(metadataTargetSizeBytes ?? 0, spacesSize ?? 0);
        const tiles = cacheTilecount ?? 0;
        if (
            sizeBytes > minFileSizeBytes ||
            tiles > minTilecount ||
            reasons.includes('metadata_mismatch_oversized_unparsed')
        ) {
            severity = 'critical';
        } else if (reasons.includes('legacy_safe_to_parse_on_oversized')) {
            severity = 'high';
        } else if (
            metadataTargetSizeBytes !== null &&
            metadataTargetSizeBytes > minFileSizeBytes * 0.5
        ) {
            severity = 'medium';
        } else {
            severity = 'low';
        }
    }

    return {
        fileId: file.id,
        transformGateOpen,
        crashRisk,
        severity,
        reasons,
        targetLevel,
        targetLevelName,
        targetLevelOversized,
        targetOversizedUnparsed,
        metadataTargetSizeBytes,
        spacesTargetSizeBytes: spacesSize ?? null,
        cacheTilecount,
        targetSafeToParse,
        hasSongFiles,
    };
}

function entryMatchesTarget(entry: LevelFileEntry, targetPath: string): boolean {
    if (entry.path === targetPath) return true;
    return typeof entry.path === 'string' && targetPath.endsWith(entry.path);
}

function patchLevelFileCollection<T extends LevelFileEntry[] | Record<string, LevelFileEntry>>(
    collection: T,
    targetPath: string
): { next: T; changed: boolean } {
    let changed = false;

    if (Array.isArray(collection)) {
        const next = collection.map((entry) => {
            if (!entryMatchesTarget(entry, targetPath)) {
                return entry;
            }
            if (entry.oversizedUnparsed === true) {
                return entry;
            }
            changed = true;
            return { ...entry, oversizedUnparsed: true };
        });
        return { next: next as T, changed };
    }

    const next: Record<string, LevelFileEntry> = {};
    for (const [key, entry] of Object.entries(collection)) {
        if (!entryMatchesTarget(entry, targetPath)) {
            next[key] = entry;
            continue;
        }
        if (entry.oversizedUnparsed === true) {
            next[key] = entry;
            continue;
        }
        changed = true;
        next[key] = { ...entry, oversizedUnparsed: true };
    }
    return { next: next as T, changed };
}

/**
 * Metadata patch applied by the fix script: closes the transform gate and aligns per-file flags
 * with ingest-time oversized handling (see zipMetadataRoutes target-level update).
 */
export function buildOversizedGateMetadataFix(
    metadata: LevelzipMetadata,
    targetLevelPath: string | null
): { metadata: LevelzipMetadata; changed: boolean } {
    let changed = false;
    const next: LevelzipMetadata = { ...metadata };

    if (next.targetLevelOversized !== true) {
        next.targetLevelOversized = true;
        changed = true;
    }
    if (next.targetSafeToParse !== false) {
        next.targetSafeToParse = false;
        changed = true;
    }
    if (next.targetSafeToParseVersion !== undefined) {
        delete next.targetSafeToParseVersion;
        changed = true;
    }

    if (targetLevelPath) {
        if (next.allLevelFiles) {
            const patched = patchLevelFileCollection(next.allLevelFiles, targetLevelPath);
            if (patched.changed) {
                next.allLevelFiles = patched.next;
                changed = true;
            }
        }
        if (next.levelFiles) {
            const patched = patchLevelFileCollection(next.levelFiles, targetLevelPath);
            if (patched.changed) {
                next.levelFiles = patched.next;
                changed = true;
            }
        }
    }

    return { metadata: next, changed };
}

export function hitNeedsMetadataFix(hit: TransformExposureHit): boolean {
    return hit.crashRisk && !hit.targetLevelOversized;
}

async function attachLevelIds(hits: TransformExposureHit[]): Promise<void> {
    const ids = hits.map((h) => h.fileId);
    if (ids.length === 0) return;

    const levels = await Level.findAll({
        where: { fileId: { [Op.in]: ids } },
        attributes: ['id', 'fileId'],
    });
    const byFileId = new Map<string, number[]>();
    for (const row of levels) {
        if (!row.fileId) continue;
        const list = byFileId.get(row.fileId) ?? [];
        list.push(row.id);
        byFileId.set(row.fileId, list);
    }
    for (const hit of hits) {
        const levelIds = byFileId.get(hit.fileId);
        if (levelIds?.length) {
            hit.levelIds = levelIds;
        }
    }
}

export async function scanTransformOversizeExposure(
    options: TransformExposureScanOptions
): Promise<TransformExposureScanSummary> {
    const minFileSizeBytes = options.minFileSizeBytes ?? MAX_LEVEL_FILE_SIZE_FOR_PARSE;
    const minTilecount = options.minTilecount ?? MAX_LEVEL_TILECOUNT_FOR_FULL_PARSE;
    const onlyExposed = options.onlyExposed === true;
    const verifySpaces = options.verifySpaces === true;
    const withLevelIds = options.withLevelIds === true;
    const batchSize = Math.max(1, options.batchSize ?? 500);
    const maxRows = options.limit ?? null;
    let offset = Math.max(0, options.offset ?? 0);
    const fileId = options.fileId ?? null;

    const where: Record<string, unknown> = { type: 'LEVELZIP' };
    if (fileId) {
        where.id = fileId;
    }

    const hits: TransformExposureHit[] = [];
    let scanned = 0;
    let transformGateOpenCount = 0;
    let crashRiskCount = 0;

    const processRow = async (row: CdnFile) => {
        scanned++;
        const meta = (row.metadata || {}) as LevelzipMetadata;
        const { path: targetPath } = resolveTransformTarget(meta);

        let spacesTargetSizeBytes: number | null | undefined;
        let spacesChecked = false;
        if (verifySpaces && targetPath && options.getSpacesTargetSizeBytes) {
            spacesChecked = true;
            spacesTargetSizeBytes = await options.getSpacesTargetSizeBytes(targetPath);
        }

        const hit = evaluateTransformOversizeExposure(row, {
            minFileSizeBytes,
            minTilecount,
            ...(spacesChecked ? { spacesTargetSizeBytes, spacesChecked: true } : {}),
        });

        if (hit.transformGateOpen) transformGateOpenCount++;
        if (hit.crashRisk) crashRiskCount++;
        if (!onlyExposed || hit.crashRisk) hits.push(hit);
    };

    if (fileId) {
        const row = await CdnFile.findOne({
            where,
            attributes: ['id', 'metadata', 'cacheData'],
        });
        if (!row) {
            throw new Error(`No LEVELZIP cdn_files row for ${fileId}`);
        }
        await processRow(row);
    } else {
        while (true) {
            const remaining = maxRows != null ? Math.max(0, maxRows - scanned) : batchSize;
            if (maxRows != null && remaining <= 0) break;
            const thisLimit = maxRows != null ? Math.min(batchSize, remaining) : batchSize;

            const rows = await CdnFile.findAll({
                where,
                attributes: ['id', 'metadata', 'cacheData'],
                order: [['id', 'ASC']],
                limit: thisLimit,
                offset,
            });

            if (rows.length === 0) break;

            for (const row of rows) {
                await processRow(row);
            }

            offset += rows.length;
            if (rows.length < thisLimit) break;
            if (maxRows != null && scanned >= maxRows) break;
        }
    }

    const exposedHits = hits.filter((h) => h.crashRisk);
    if (withLevelIds && exposedHits.length > 0) {
        await attachLevelIds(exposedHits);
    }

    const bySeverity = {
        critical: exposedHits.filter((h) => h.severity === 'critical').length,
        high: exposedHits.filter((h) => h.severity === 'high').length,
        medium: exposedHits.filter((h) => h.severity === 'medium').length,
        low: exposedHits.filter((h) => h.severity === 'low').length,
    };

    const byReason: Record<string, number> = {};
    for (const h of exposedHits) {
        for (const r of h.reasons) {
            byReason[r] = (byReason[r] ?? 0) + 1;
        }
    }

    return {
        scanned,
        transformGateOpenCount,
        crashRiskCount,
        limits: {
            maxLevelFileSizeForParse: MAX_LEVEL_FILE_SIZE_FOR_PARSE,
            maxLevelTilecountForFullParse: MAX_LEVEL_TILECOUNT_FOR_FULL_PARSE,
            auditMinFileSizeBytes: minFileSizeBytes,
            auditMinTilecount: minTilecount,
        },
        bySeverity,
        byReason,
        hits: onlyExposed ? exposedHits : hits,
        exposedOnly: onlyExposed,
        verifySpaces,
    };
}
