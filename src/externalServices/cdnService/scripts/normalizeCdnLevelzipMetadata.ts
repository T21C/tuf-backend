#!/usr/bin/env npx tsx
/**
 * One-off / periodic cleanup of `cdn_files.metadata` for LEVELZIP rows.
 *
 * Removes migration-era and redundant fields (local paths, migratedAt, storageInfo,
 * redistributed*, top-level storage duplicates, etc.) while keeping the shape required by
 * CDN routes, level cache, and `getOriginalArchiveMeta` — see
 * `domain/metadata/normalizeLevelzipMetadata.ts`.
 *
 * Processes **all** matching rows in batches (default batch size 1000) until the table end,
 * unless `--max-rows` / legacy `--limit` caps the total.
 *
 * Usage (from server/):
 *   npx tsx src/externalServices/cdnService/scripts/normalizeCdnLevelzipMetadata.ts
 *   npx tsx src/externalServices/cdnService/scripts/normalizeCdnLevelzipMetadata.ts --apply --batch-size 500
 *   npx tsx src/externalServices/cdnService/scripts/normalizeCdnLevelzipMetadata.ts --apply --max-rows 10000
 *   npx tsx src/externalServices/cdnService/scripts/normalizeCdnLevelzipMetadata.ts --apply --offset 50000
 *   npx tsx src/externalServices/cdnService/scripts/normalizeCdnLevelzipMetadata.ts --apply --file-id <uuid>
 */

import { Command } from 'commander';
import dotenv from 'dotenv';

dotenv.config();

import CdnFile from '@/models/cdn/CdnFile.js';
import { getSequelizeForModelGroup } from '@/config/db.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { initializeAssociations } from '@/models/associations.js';
import {
    listRemovedTopLevelKeys,
    normalizeLevelzipMetadata,
} from '../domain/metadata/normalizeLevelzipMetadata.js';

initializeAssociations();

const cdnSequelize = getSequelizeForModelGroup('cdn');

const SAMPLE_KEY_CAP = 12;

async function main(): Promise<void> {
    const program = new Command();
    program
        .option('--apply', 'Persist normalized metadata (default is dry-run)', false)
        .option('--batch-size <n>', 'Rows per SELECT batch', '1000')
        .option('--max-rows <n>', 'Optional cap on total rows processed (omit = entire table)')
        .option('--limit <n>', 'Deprecated: same as --max-rows')
        .option('--offset <n>', 'Skip first n LEVELZIP rows (order by id)', '0')
        .option('--file-id <uuid>', 'Normalize a single cdn_files.id')
        .parse();

    const opts = program.opts<{
        apply?: boolean;
        batchSize?: string;
        maxRows?: string;
        limit?: string;
        offset?: string;
        fileId?: string;
    }>();
    const apply = opts.apply === true;
    const batchSize = Math.max(1, parseInt(String(opts.batchSize || '1000'), 10) || 1000);
    const maxRowsRaw = opts.maxRows ?? opts.limit;
    const maxRows =
        maxRowsRaw !== undefined && maxRowsRaw !== null && String(maxRowsRaw).trim() !== ''
            ? Math.max(1, parseInt(String(maxRowsRaw), 10) || 0) || null
            : null;
    const initialOffset = Math.max(0, parseInt(String(opts.offset || '0'), 10) || 0);
    let offset = initialOffset;
    const fileId = opts.fileId ? String(opts.fileId) : null;

    if (opts.limit && opts.maxRows) {
        logger.warn('normalizeCdnLevelzipMetadata: both --limit and --max-rows set; using --max-rows');
    }

    const where: Record<string, unknown> = { type: 'LEVELZIP' };
    if (fileId) {
        where.id = fileId;
    }

    let scanned = 0;
    let changed = 0;
    let bytesSaved = 0;
    const sampleRemoved: string[] = [];

    if (fileId) {
        const rows = await CdnFile.findAll({
            where,
            attributes: ['id', 'metadata'],
            order: [['id', 'ASC']],
            limit: 1,
        });
        for (const row of rows) {
            scanned++;
            const meta = row.metadata;
            if (!meta || typeof meta !== 'object') {
                continue;
            }
            const { normalized, changed: isChanged, bytesSavedEstimate } = normalizeLevelzipMetadata(meta);
            if (!isChanged) {
                continue;
            }
            changed++;
            bytesSaved += Math.max(0, bytesSavedEstimate);
            if (sampleRemoved.length < SAMPLE_KEY_CAP) {
                const removed = listRemovedTopLevelKeys(meta);
                if (removed.length) {
                    sampleRemoved.push(
                        `${row.id}: ${removed.slice(0, 8).join(', ')}${removed.length > 8 ? '…' : ''}`,
                    );
                }
            }
            if (apply) {
                const t = await cdnSequelize.transaction();
                try {
                    await row.update({ metadata: normalized }, { transaction: t });
                    await t.commit();
                } catch (e) {
                    await t.rollback();
                    throw e;
                }
            }
        }
    } else {
        while (true) {
            const processedSoFar = scanned;
            const remaining =
                maxRows != null ? Math.max(0, maxRows - processedSoFar) : batchSize;
            if (maxRows != null && remaining <= 0) {
                break;
            }
            const thisLimit = maxRows != null ? Math.min(batchSize, remaining) : batchSize;

            const rows = await CdnFile.findAll({
                where,
                attributes: ['id', 'metadata'],
                order: [['id', 'ASC']],
                limit: thisLimit,
                offset,
            });

            if (rows.length === 0) {
                break;
            }

            for (const row of rows) {
                scanned++;
                const meta = row.metadata;
                if (!meta || typeof meta !== 'object') {
                    continue;
                }
                const { normalized, changed: isChanged, bytesSavedEstimate } =
                    normalizeLevelzipMetadata(meta);
                if (!isChanged) {
                    continue;
                }
                changed++;
                bytesSaved += Math.max(0, bytesSavedEstimate);
                if (sampleRemoved.length < SAMPLE_KEY_CAP) {
                    const removed = listRemovedTopLevelKeys(meta);
                    if (removed.length) {
                        sampleRemoved.push(
                            `${row.id}: ${removed.slice(0, 8).join(', ')}${removed.length > 8 ? '…' : ''}`,
                        );
                    }
                }

                if (apply) {
                    const t = await cdnSequelize.transaction();
                    try {
                        await row.update({ metadata: normalized }, { transaction: t });
                        await t.commit();
                    } catch (e) {
                        await t.rollback();
                        throw e;
                    }
                }
            }

            offset += rows.length;

            if (rows.length < thisLimit) {
                break;
            }
            if (maxRows != null && scanned >= maxRows) {
                break;
            }
        }
    }

    const summary = {
        apply,
        batchSize: fileId ? 1 : batchSize,
        maxRows,
        startOffset: fileId ? 0 : initialOffset,
        scanned,
        changed,
        approxBytesSaved: bytesSaved,
        sampleRemovedKeys: sampleRemoved,
    };
    // Single-line log: passing a second object to winston duplicates JSON in our formatter.
    logger.info(`normalizeCdnLevelzipMetadata complete ${JSON.stringify(summary)}`);

    if (!apply && changed > 0) {
        // eslint-disable-next-line no-console
        console.log(`Dry run: ${changed}/${scanned} row(s) would shrink. Re-run with --apply to persist.`);
    }
}

main().catch((err) => {
    logger.error(`normalizeCdnLevelzipMetadata failed ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
