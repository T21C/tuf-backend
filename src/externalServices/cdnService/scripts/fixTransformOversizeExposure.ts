/**
 * Repair LEVELZIP rows flagged by {@link auditTransformOversizeExposure.ts}: set
 * `targetLevelOversized`, clear legacy `targetSafeToParse*`, mark target `oversizedUnparsed`,
 * drop full parse cache, and rebuild minimal oversized cache (no LevelDict on target).
 *
 * Usage (from server/):
 *   npx tsx src/externalServices/cdnService/scripts/fixTransformOversizeExposure.ts
 *   npx tsx src/externalServices/cdnService/scripts/fixTransformOversizeExposure.ts --help
 *   npx tsx src/externalServices/cdnService/scripts/fixTransformOversizeExposure.ts --apply
 *   npx tsx src/externalServices/cdnService/scripts/fixTransformOversizeExposure.ts --apply --file-id <uuid>
 *   npx tsx src/externalServices/cdnService/scripts/fixTransformOversizeExposure.ts --apply --from-json ./transform-exposed.json
 */

import {parseArgs} from 'node:util';
import {readFile} from 'node:fs/promises';
import dotenv from 'dotenv';
import {Transaction} from 'sequelize';

dotenv.config();

import CdnFile from '@/models/cdn/CdnFile.js';
import {getSequelizeForModelGroup} from '@/config/db.js';
import {initializeAssociations} from '@/models/associations.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {safeTransactionRollback} from '@/misc/utils/Utility.js';
import {spacesStorage} from '../infra/storage/spacesStorage.js';
import {levelCacheService} from '../services/levelCacheService.js';
import {
    MAX_LEVEL_FILE_SIZE_FOR_PARSE,
    MAX_LEVEL_TILECOUNT_FOR_FULL_PARSE,
} from '../domain/level/levelParseLimits.js';
import {
    buildOversizedGateMetadataFix,
    evaluateTransformOversizeExposure,
    hitNeedsMetadataFix,
    scanTransformOversizeExposure,
    type LevelzipMetadata,
    type TransformExposureHit,
} from '../domain/level/transformOversizeExposureAudit.js';

initializeAssociations();

const cdnSequelize = getSequelizeForModelGroup('cdn');

interface CliOptions {
    apply: boolean;
    fileId?: string;
    fromJson?: string;
    offset: number;
    limit?: number;
    batchSize: number;
    onlyExposed: boolean;
    verifySpaces: boolean;
    minFileSizeBytes: number;
    minTilecount: number;
    rebuildCache: boolean;
}

interface FixStats {
    scanned: number;
    candidates: number;
    fixed: number;
    skippedAlreadyBlocked: number;
    skippedNoMetadataChange: number;
    cacheRebuilt: number;
    cacheFailed: number;
    errors: Array<{fileId: string; error: string}>;
}

function printHelp(): void {
    const text = `
fixTransformOversizeExposure.ts

Repairs LEVELZIP metadata so GET /:fileId/transform rejects oversized targets (same gate as
fresh ingest). Uses the same exposure rules as the audit scan script.

Run audit first (read-only):
  npx tsx src/externalServices/cdnService/scripts/auditTransformOversizeExposure.ts --only-exposed

By default this script is DRY-RUN. Pass --apply to persist.

Per candidate row:
  1. Set metadata.targetLevelOversized = true
  2. Set metadata.targetSafeToParse = false, remove targetSafeToParseVersion
  3. Set target allLevelFiles / levelFiles entry oversizedUnparsed = true
  4. Clear cacheData (drops full LevelDict cache)
  5. Unless --skip-cache-rebuild: levelCacheService.refreshCache (minimal oversized cache)

FLAGS
  --help, -h
    Show this help.

  --apply
    Persist metadata + cache changes. Default: false (dry-run).

  --file-id <uuid>
    Fix a single cdn_files.id (still must match exposure rules unless --force).

  --from-json <path>
    Only fix fileIds listed under hits[].fileId in a prior audit export (--only-exposed JSON).

  --offset <n> / --limit <n> / --batch-size <n>
    Same pagination as audit script when scanning the table.

  --only-exposed
    When scanning, only consider crashRisk hits (default: true).

  --no-only-exposed
    Scan all rows but still only fix crashRisk candidates.

  --verify-spaces
    Include Spaces HEAD in exposure evaluation (slower).

  --min-size-bytes <n> / --min-tilecount <n>
    Exposure thresholds (defaults: ingest limits).

  --skip-cache-rebuild
    Metadata-only fix; do not call refreshCache after update.

  --force
    With --file-id, fix even if audit would not flag crashRisk (sets oversized gate only).

EXAMPLES
  Dry-run all exposed:
    npx tsx src/externalServices/cdnService/scripts/fixTransformOversizeExposure.ts

  Apply fixes:
    npx tsx src/externalServices/cdnService/scripts/fixTransformOversizeExposure.ts --apply

  Apply from audit export:
    npx tsx src/externalServices/cdnService/scripts/fixTransformOversizeExposure.ts --apply --from-json ./transform-exposed.json

  Single file:
    npx tsx src/externalServices/cdnService/scripts/fixTransformOversizeExposure.ts --apply --file-id <uuid>
`.trim();

    // eslint-disable-next-line no-console
    console.log(text);
}

async function loadFileIdsFromAuditJson(path: string): Promise<string[]> {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as {hits?: Array<{fileId?: string}>};
    if (!parsed.hits || !Array.isArray(parsed.hits)) {
        throw new Error('--from-json: expected { hits: [{ fileId }] }');
    }
    const ids = parsed.hits
        .map((h) => (typeof h.fileId === 'string' ? h.fileId.trim() : ''))
        .filter((id) => id.length > 0);
    if (ids.length === 0) {
        throw new Error('--from-json: no fileIds in hits');
    }
    return [...new Set(ids)];
}

async function fixOneFile(
    fileId: string,
    opts: CliOptions,
    stats: FixStats,
    force: boolean
): Promise<void> {
    const file = await CdnFile.findByPk(fileId, {
        attributes: ['id', 'type', 'metadata', 'cacheData'],
    });
    if (!file || file.type !== 'LEVELZIP') {
        stats.errors.push({fileId, error: 'LEVELZIP row not found'});
        return;
    }

    const hit = evaluateTransformOversizeExposure(file, {
        minFileSizeBytes: opts.minFileSizeBytes,
        minTilecount: opts.minTilecount,
    });

    if (!force && !hitNeedsMetadataFix(hit)) {
        if (!hit.crashRisk && hit.targetLevelOversized) {
            stats.skippedAlreadyBlocked++;
        } else {
            stats.skippedNoMetadataChange++;
        }
        return;
    }

    stats.candidates++;

    const metadata = (file.metadata || {}) as LevelzipMetadata;
    const {metadata: nextMetadata, changed} = buildOversizedGateMetadataFix(
        metadata,
        hit.targetLevel
    );

    const willChangeMetadata = changed || force;
    const willClearCache = file.cacheData != null;

    if (!opts.apply) {
        logger.info('[DRY RUN] would fix LEVELZIP oversized transform exposure', {
            fileId,
            targetLevel: hit.targetLevel,
            reasons: hit.reasons,
            metadataChanged: willChangeMetadata,
            clearCache: willClearCache,
            rebuildCache: opts.rebuildCache,
        });
        stats.fixed++;
        return;
    }

    let transaction: Transaction | undefined;
    try {
        transaction = await cdnSequelize.transaction();
        await file.update(
            {
                metadata: nextMetadata,
                cacheData: null,
            },
            {transaction}
        );
        await transaction.commit();
        stats.fixed++;

        if (opts.rebuildCache) {
            try {
                const cache = await levelCacheService.refreshCache(fileId);
                if (cache) {
                    stats.cacheRebuilt++;
                } else {
                    stats.cacheFailed++;
                    logger.warn('refreshCache returned null after oversized fix', {fileId});
                }
            } catch (cacheErr) {
                stats.cacheFailed++;
                logger.warn('refreshCache failed after oversized fix (metadata still saved)', {
                    fileId,
                    error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
                });
            }
        }
    } catch (err) {
        await safeTransactionRollback(transaction);
        stats.errors.push({
            fileId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

async function runFixFromHits(hits: TransformExposureHit[], opts: CliOptions, stats: FixStats): Promise<void> {
    for (const hit of hits) {
        if (!hitNeedsMetadataFix(hit)) {
            stats.skippedAlreadyBlocked++;
            continue;
        }
        await fixOneFile(hit.fileId, opts, stats, false);
    }
}

async function runScript(): Promise<void> {
    const {values} = parseArgs({
        options: {
            help: {type: 'boolean', short: 'h', default: false},
            apply: {type: 'boolean', default: false},
            'file-id': {type: 'string'},
            'from-json': {type: 'string'},
            offset: {type: 'string', default: '0'},
            limit: {type: 'string'},
            'batch-size': {type: 'string', default: '500'},
            'only-exposed': {type: 'boolean', default: true},
            'no-only-exposed': {type: 'boolean', default: false},
            'verify-spaces': {type: 'boolean', default: false},
            'min-size-bytes': {type: 'string', default: String(MAX_LEVEL_FILE_SIZE_FOR_PARSE)},
            'min-tilecount': {type: 'string', default: String(MAX_LEVEL_TILECOUNT_FOR_FULL_PARSE)},
            'skip-cache-rebuild': {type: 'boolean', default: false},
            force: {type: 'boolean', default: false},
        },
        allowPositionals: false,
    });

    if (values.help) {
        printHelp();
        return;
    }

    const offset = parseInt(String(values.offset), 10);
    if (!Number.isFinite(offset) || offset < 0) {
        throw new Error('Invalid --offset');
    }

    const limitRaw = values.limit;
    const limit =
        limitRaw != null && String(limitRaw).trim() !== ''
            ? parseInt(String(limitRaw), 10)
            : undefined;
    if (limit != null && (!Number.isFinite(limit) || limit < 1)) {
        throw new Error('Invalid --limit');
    }

    const batchSize = parseInt(String(values['batch-size']), 10);
    if (!Number.isFinite(batchSize) || batchSize < 1) {
        throw new Error('Invalid --batch-size');
    }

    const opts: CliOptions = {
        apply: Boolean(values.apply),
        fileId: values['file-id']?.trim() || undefined,
        fromJson: values['from-json']?.trim() || undefined,
        offset,
        limit,
        batchSize,
        onlyExposed: values['no-only-exposed'] ? false : Boolean(values['only-exposed']),
        verifySpaces: Boolean(values['verify-spaces']),
        minFileSizeBytes: parseInt(String(values['min-size-bytes']), 10),
        minTilecount: parseInt(String(values['min-tilecount']), 10),
        rebuildCache: !values['skip-cache-rebuild'],
    };

    if (!Number.isFinite(opts.minFileSizeBytes) || opts.minFileSizeBytes < 1) {
        throw new Error('Invalid --min-size-bytes');
    }
    if (!Number.isFinite(opts.minTilecount) || opts.minTilecount < 1) {
        throw new Error('Invalid --min-tilecount');
    }

    const force = Boolean(values.force);
    if (force && !opts.fileId) {
        throw new Error('--force requires --file-id');
    }

    const stats: FixStats = {
        scanned: 0,
        candidates: 0,
        fixed: 0,
        skippedAlreadyBlocked: 0,
        skippedNoMetadataChange: 0,
        cacheRebuilt: 0,
        cacheFailed: 0,
        errors: [],
    };

    const t0 = Date.now();
    await cdnSequelize.authenticate();
    logger.info('DB OK', {mode: 'fix', dryRun: !opts.apply});

    if (opts.fileId) {
        await fixOneFile(opts.fileId, opts, stats, force);
    } else if (opts.fromJson) {
        const fileIds = await loadFileIdsFromAuditJson(opts.fromJson);
        stats.scanned = fileIds.length;
        for (const fileId of fileIds) {
            await fixOneFile(fileId, opts, stats, false);
        }
    } else {
        const scan = await scanTransformOversizeExposure({
            offset: opts.offset,
            limit: opts.limit ?? null,
            batchSize: opts.batchSize,
            onlyExposed: opts.onlyExposed,
            verifySpaces: opts.verifySpaces,
            minFileSizeBytes: opts.minFileSizeBytes,
            minTilecount: opts.minTilecount,
            getSpacesTargetSizeBytes: opts.verifySpaces
                ? async (targetPath) => {
                      const head = await spacesStorage.getFileMetadata(targetPath);
                      return typeof head?.ContentLength === 'number' ? head.ContentLength : null;
                  }
                : undefined,
        });
        stats.scanned = scan.scanned;
        await runFixFromHits(scan.hits, opts, stats);
    }

    logger.info('Fix complete', {
        elapsedMs: Date.now() - t0,
        dryRun: !opts.apply,
        ...stats,
    });

    if (!opts.apply && stats.candidates > 0) {
        // eslint-disable-next-line no-console
        console.log(`Dry run: ${stats.candidates} row(s) would be fixed. Re-run with --apply to persist.`);
    }

    if (stats.errors.length > 0) {
        process.exitCode = 1;
    }
}

runScript()
    .catch((e) => {
        logger.error(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
    })
    .finally(async () => {
        await cdnSequelize.close();
    })
    .then(() => {
        process.exit(process.exitCode ?? 0);
    });
