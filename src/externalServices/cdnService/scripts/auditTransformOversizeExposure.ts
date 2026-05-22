#!/usr/bin/env npx tsx
/**
 * Find LEVELZIP rows where GET /:fileId/transform can still run a full LevelDict parse
 * despite oversized ingest limits — typically legacy uploads before `targetLevelOversized`
 * was set correctly, or metadata mismatch (`oversizedUnparsed` on the target entry but
 * `targetLevelOversized` false/missing).
 *
 * Read-only: scans `cdn_files` metadata (and optionally Spaces HEAD for the target .adofai).
 *
 * Usage (from server/):
 *   npx tsx src/externalServices/cdnService/scripts/auditTransformOversizeExposure.ts
 *   npx tsx src/externalServices/cdnService/scripts/auditTransformOversizeExposure.ts --only-exposed
 *   npx tsx src/externalServices/cdnService/scripts/auditTransformOversizeExposure.ts --verify-spaces --limit 500
 *   npx tsx src/externalServices/cdnService/scripts/auditTransformOversizeExposure.ts --file-id <uuid> --with-level-ids
 */

import { Command } from 'commander';
import dotenv from 'dotenv';
import { Op } from 'sequelize';

dotenv.config();

import Level from '@/models/levels/Level.js';
import CdnFile from '@/models/cdn/CdnFile.js';
import { getSequelizeForModelGroup } from '@/config/db.js';
import { initializeAssociations } from '@/models/associations.js';
import { deriveLargestLevelFromRaw } from '../http/routes/levels/shared/routeUtils.js';
import {
    MAX_LEVEL_FILE_SIZE_FOR_PARSE,
    MAX_LEVEL_TILECOUNT_FOR_FULL_PARSE,
} from '../domain/level/levelParseLimits.js';
import { spacesStorage } from '../infra/storage/spacesStorage.js';

initializeAssociations();

const cdnSequelize = getSequelizeForModelGroup('cdn');

type LevelFileEntry = {
    name?: string;
    path?: string;
    size?: number;
    relativePath?: string;
    oversizedUnparsed?: boolean;
};

type LevelzipMetadata = {
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
    /** Transform route only blocks when this is strictly true. */
    transformGateOpen: boolean;
    /** Would pass transform pre-checks and reach LevelDict(parse) on the target path. */
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

function collectLevelEntries(metadata: LevelzipMetadata): LevelFileEntry[] {
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

function resolveTransformTarget(metadata: LevelzipMetadata): {
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
    const entry =
        entries.find((e) => e.path === path) ||
        entries.find((e) => typeof e.path === 'string' && path!.endsWith(e.path)) ||
        null;

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

/**
 * Mirrors transform route: oversized levels are blocked only when `targetLevelOversized === true`.
 */
export function evaluateTransformOversizeExposure(
    file: Pick<CdnFile, 'id' | 'metadata' | 'cacheData'>,
    options: {
        minFileSizeBytes?: number;
        minTilecount?: number;
        /** Set when --verify-spaces ran; null means HEAD miss or missing ContentLength. */
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

    const canReachParse =
        transformGateOpen && hasSongFiles && !!targetLevel;

    const crashRisk = canReachParse && reasons.length > 0;

    let severity: TransformExposureHit['severity'] = 'none';
    if (crashRisk) {
        const sizeBytes = Math.max(
            metadataTargetSizeBytes ?? 0,
            spacesSize ?? 0
        );
        const tiles = cacheTilecount ?? 0;
        if (
            sizeBytes > minFileSizeBytes ||
            tiles > minTilecount ||
            reasons.includes('metadata_mismatch_oversized_unparsed')
        ) {
            severity = 'critical';
        } else if (reasons.includes('legacy_safe_to_parse_on_oversized')) {
            severity = 'high';
        } else if (metadataTargetSizeBytes !== null && metadataTargetSizeBytes > minFileSizeBytes * 0.5) {
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

async function main(): Promise<void> {
    const program = new Command();
    program
        .name('audit-transform-oversize-exposure')
        .description(
            'List LEVELZIP rows where transform can still full-parse levels that exceed ingest limits'
        )
        .option('--file-id <uuid>', 'Audit a single cdn_files.id')
        .option('--offset <n>', 'Skip first n LEVELZIP rows (order by id)', '0')
        .option('--limit <n>', 'Max rows to scan (omit = all)')
        .option('--batch-size <n>', 'SELECT batch size', '500')
        .option('--only-exposed', 'Output only crashRisk hits', false)
        .option('--verify-spaces', 'HEAD target .adofai in Spaces (slower)', false)
        .option('--with-level-ids', 'Attach levels.id for each hit', false)
        .option(
            '--min-size-bytes <n>',
            'Treat as oversized file size (default MAX_LEVEL_FILE_SIZE_FOR_PARSE)',
            String(MAX_LEVEL_FILE_SIZE_FOR_PARSE)
        )
        .option(
            '--min-tilecount <n>',
            'Treat as oversized tile count (default MAX_LEVEL_TILECOUNT_FOR_FULL_PARSE)',
            String(MAX_LEVEL_TILECOUNT_FOR_FULL_PARSE)
        )
        .parse();

    const opts = program.opts<{
        fileId?: string;
        offset?: string;
        limit?: string;
        batchSize?: string;
        onlyExposed?: boolean;
        verifySpaces?: boolean;
        withLevelIds?: boolean;
        minSizeBytes?: string;
        minTilecount?: string;
    }>();

    const minFileSizeBytes = Math.max(1, parseInt(String(opts.minSizeBytes), 10) || MAX_LEVEL_FILE_SIZE_FOR_PARSE);
    const minTilecount = Math.max(1, parseInt(String(opts.minTilecount), 10) || MAX_LEVEL_TILECOUNT_FOR_FULL_PARSE);
    const onlyExposed = opts.onlyExposed === true;
    const verifySpaces = opts.verifySpaces === true;
    const withLevelIds = opts.withLevelIds === true;
    const batchSize = Math.max(1, parseInt(String(opts.batchSize || '500'), 10) || 500);
    const maxRows =
        opts.limit !== undefined && String(opts.limit).trim() !== ''
            ? Math.max(1, parseInt(String(opts.limit), 10) || 0)
            : null;
    let offset = Math.max(0, parseInt(String(opts.offset || '0'), 10) || 0);
    const fileId = opts.fileId ? String(opts.fileId) : null;

    const where: Record<string, unknown> = { type: 'LEVELZIP' };
    if (fileId) {
        where.id = fileId;
    }

    const hits: TransformExposureHit[] = [];
    let scanned = 0;
    let gateOpenCount = 0;
    let crashRiskCount = 0;

    const processRow = async (row: CdnFile) => {
        scanned++;
        const meta = (row.metadata || {}) as LevelzipMetadata;
        const { path: targetPath } = resolveTransformTarget(meta);

        let spacesTargetSizeBytes: number | null | undefined;
        let spacesChecked = false;
        if (verifySpaces && targetPath) {
            spacesChecked = true;
            const head = await spacesStorage.getFileMetadata(targetPath);
            spacesTargetSizeBytes =
                typeof head?.ContentLength === 'number' ? head.ContentLength : null;
        }

        const hit = evaluateTransformOversizeExposure(row, {
            minFileSizeBytes,
            minTilecount,
            ...(spacesChecked ? { spacesTargetSizeBytes, spacesChecked: true } : {}),
        });

        if (hit.transformGateOpen) {
            gateOpenCount++;
        }
        if (hit.crashRisk) {
            crashRiskCount++;
        }

        if (!onlyExposed || hit.crashRisk) {
            hits.push(hit);
        }
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

    const output = {
        scanned,
        transformGateOpenCount: gateOpenCount,
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

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(output, null, 2));

    await cdnSequelize.close();
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
