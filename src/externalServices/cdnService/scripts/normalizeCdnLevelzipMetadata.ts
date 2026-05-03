#!/usr/bin/env npx tsx
/**
 * One-off / periodic cleanup of `cdn_files.metadata` for LEVELZIP rows.
 *
 * Removes migration-era and redundant fields (local paths, migratedAt, storageInfo,
 * redistributed*, top-level storage duplicates, etc.) while keeping the shape required by
 * CDN routes, level cache, and `getOriginalArchiveMeta` — see
 * `domain/metadata/normalizeLevelzipMetadata.ts`.
 *
 * Usage (from server/):
 *   npx tsx src/externalServices/cdnService/scripts/normalizeCdnLevelzipMetadata.ts
 *   npx tsx src/externalServices/cdnService/scripts/normalizeCdnLevelzipMetadata.ts --apply --limit 500
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

async function main(): Promise<void> {
    const program = new Command();
    program
        .option('--apply', 'Persist normalized metadata (default is dry-run)', false)
        .option('--limit <n>', 'Max rows to scan', '2000')
        .option('--offset <n>', 'Skip first n LEVELZIP rows (order by id)', '0')
        .option('--file-id <uuid>', 'Normalize a single cdn_files.id')
        .parse();

    const opts = program.opts<{ apply?: boolean; limit?: string; offset?: string; fileId?: string }>();
    const apply = opts.apply === true;
    const limit = Math.max(1, parseInt(String(opts.limit || '2000'), 10) || 2000);
    const offset = Math.max(0, parseInt(String(opts.offset || '0'), 10) || 0);
    const fileId = opts.fileId ? String(opts.fileId) : null;

    const where: Record<string, unknown> = { type: 'LEVELZIP' };
    if (fileId) {
        where.id = fileId;
    }

    const rows = await CdnFile.findAll({
        where,
        attributes: ['id', 'metadata'],
        order: [['id', 'ASC']],
        limit: fileId ? 1 : limit,
        offset: fileId ? 0 : offset,
    });

    let changed = 0;
    let scanned = 0;
    let bytesSaved = 0;
    const sampleRemoved: string[] = [];

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
        if (sampleRemoved.length < 12) {
            const removed = listRemovedTopLevelKeys(meta);
            if (removed.length) {
                sampleRemoved.push(`${row.id}: ${removed.slice(0, 8).join(', ')}${removed.length > 8 ? '…' : ''}`);
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

    logger.info('normalizeCdnLevelzipMetadata complete', {
        apply,
        scanned,
        changed,
        approxBytesSaved: bytesSaved,
        sampleRemovedKeys: sampleRemoved,
    });

    if (!apply && changed > 0) {
        // eslint-disable-next-line no-console
        console.log(`Dry run: ${changed}/${scanned} row(s) would shrink. Re-run with --apply to persist.`);
        sampleRemoved.forEach((line) => {
            // eslint-disable-next-line no-console
            console.log(`  ${line}`);
        });
    }
}

main().catch((err) => {
    logger.error('normalizeCdnLevelzipMetadata failed', { err });
    process.exit(1);
});
