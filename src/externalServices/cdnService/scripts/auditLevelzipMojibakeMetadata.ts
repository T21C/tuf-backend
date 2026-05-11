#!/usr/bin/env npx tsx
/**
 * Scan persisted `cdn_files.metadata` for LEVELZIP rows and flag strings that *look* like
 * filename mojibake (wrong legacy code page / double-encoding artifacts).
 *
 * This does **not** open the archive on disk — it only inspects JSON already written at ingest
 * time. If bad names were stored before the `-mcp=` / content-aware fixes, they will still
 * appear here and can be exported for manual re-upload or DB correction.
 *
 * Heuristics (conservative; tune in `domain/metadata/mojibakeAuditLevelzipMetadata.ts`):
 *   - U+FFFD replacement character
 *   - Syriac block U+0700–U+074F (common when East-Asian ZIP bytes were mis-decoded as UTF-8)
 *   - Private Use Area U+E000–U+F8FF
 *   - C1 / control characters U+0080–U+009F inside display paths
 *
 * Usage (from server/):
 *   With stdout redirected, Winston skips its console transport for this script (non-TTY stdout) so
 *   captures stay valid NDJSON; override with TUF_SUPPRESS_CONSOLE_LOGGER=0 or =1 if needed.
 *   On Windows PowerShell 5.x, `> file.ndjson` often writes UTF-16 LE (then lines look like `{\0"\0...`
 *   when read as UTF-8). Prefer `cmd /c "npx tsx ... > mojibake-hits.ndjson"`, PowerShell 7, or
 *   `| Set-Content -Encoding utf8NoBOM`; the migrate script also auto-detects UTF-16 hits files.
 *   npx tsx src/externalServices/cdnService/scripts/auditLevelzipMojibakeMetadata.ts > mojibake-hits.ndjson
 *   npx tsx src/externalServices/cdnService/scripts/auditLevelzipMojibakeMetadata.ts --max-rows 5000
 *   npx tsx src/externalServices/cdnService/scripts/auditLevelzipMojibakeMetadata.ts --file-id <uuid>
 *   npx tsx ... --format summary   # one-line counts only
 *
 * Pipeline / CI (requires `--file-id`):
 *   npx tsx ... --file-id <uuid> --check-clean
 *     Exit 0 = no mojibake hits in that row’s metadata. Exit 2 = hits still present. Exit 1 = error (missing row, bad uuid).
 */

import { Command } from 'commander';
import dotenv from 'dotenv';

dotenv.config();

import CdnFile from '@/models/cdn/CdnFile.js';
import { auditLevelzipMetadataForMojibake } from '../domain/metadata/mojibakeAuditLevelzipMetadata.js';

const CDN_ZIP_FILE_ID_PARAM = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RowOut = { fileId: string; hitCount: number; hits: ReturnType<typeof auditLevelzipMetadataForMojibake> };

async function main(): Promise<void> {
    const program = new Command();
    program
        .option('--batch-size <n>', 'Rows per SELECT batch', '500')
        .option('--max-rows <n>', 'Cap total LEVELZIP rows scanned (omit = entire table)')
        .option('--offset <n>', 'Skip first n LEVELZIP rows (order by id)', '0')
        .option('--file-id <uuid>', 'Audit a single cdn_files.id')
        .option('--format <mode>', 'ndjson (default) | summary', 'ndjson')
        .option(
            '--check-clean',
            'Pipeline mode: requires --file-id. Exit 0 if metadata has no mojibake hits, 2 if hits remain, 1 on error. No NDJSON to stdout.',
            false,
        )
        .parse();

    const opts = program.opts<{
        batchSize?: string;
        maxRows?: string;
        offset?: string;
        fileId?: string;
        format?: string;
        checkClean?: boolean;
    }>();

    const checkClean = opts.checkClean === true;
    const batchSize = Math.max(1, parseInt(String(opts.batchSize || '500'), 10) || 500);
    const maxRows =
        opts.maxRows !== undefined && String(opts.maxRows).trim() !== ''
            ? Math.max(1, parseInt(String(opts.maxRows), 10) || 0)
            : null;
    const initialOffset = Math.max(0, parseInt(String(opts.offset || '0'), 10) || 0);
    let offset = initialOffset;
    const fileId = opts.fileId ? String(opts.fileId).trim() : null;
    const format = (opts.format || 'ndjson').toLowerCase();

    if (checkClean) {
        if (!fileId || !CDN_ZIP_FILE_ID_PARAM.test(fileId)) {
            // eslint-disable-next-line no-console
            console.error('auditLevelzipMojibakeMetadata: --check-clean requires a valid --file-id UUID');
            process.exit(1);
        }
        const row = await CdnFile.findOne({
            where: { id: fileId, type: 'LEVELZIP' },
            attributes: ['id', 'metadata'],
        });
        if (!row) {
            // eslint-disable-next-line no-console
            console.error(`auditLevelzipMojibakeMetadata: no LEVELZIP cdn_files row for ${fileId}`);
            process.exit(1);
        }
        const hits = auditLevelzipMetadataForMojibake(row.metadata);
        if (hits.length > 0) {
            // eslint-disable-next-line no-console
            console.error(
                JSON.stringify({
                    fileId,
                    hitCount: hits.length,
                    hits: hits.slice(0, 20),
                    truncated: hits.length > 20,
                }),
            );
            process.exit(2);
        }
        // eslint-disable-next-line no-console
        console.error(JSON.stringify({ fileId, ok: true, hitCount: 0 }));
        process.exit(0);
    }

    const where: Record<string, unknown> = { type: 'LEVELZIP' };
    if (fileId) {
        where.id = fileId;
    }

    let scanned = 0;
    let rowsWithHits = 0;
    let totalStringHits = 0;

    const processRow = (row: { id: string; metadata: unknown }): void => {
        scanned++;
        const hits = auditLevelzipMetadataForMojibake(row.metadata);
        if (hits.length === 0) return;
        rowsWithHits++;
        totalStringHits += hits.length;
        if (format === 'summary') {
            return;
        }
        const line: RowOut = { fileId: row.id, hitCount: hits.length, hits };
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(line));
    };

    if (fileId) {
        const rows = await CdnFile.findAll({
            where,
            attributes: ['id', 'metadata'],
            order: [['id', 'ASC']],
            limit: 1,
        });
        for (const row of rows) {
            processRow(row as { id: string; metadata: unknown });
        }
    } else {
        while (true) {
            const processedSoFar = scanned;
            const remaining = maxRows != null ? Math.max(0, maxRows - processedSoFar) : batchSize;
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
                processRow(row as { id: string; metadata: unknown });
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

    if (format === 'summary') {
        // eslint-disable-next-line no-console
        console.log(
            JSON.stringify({
                scanned,
                rowsWithHits,
                totalStringHits,
                batchSize: fileId ? 1 : batchSize,
                maxRows,
                startOffset: fileId ? 0 : initialOffset,
            }),
        );
        return;
    }

    // eslint-disable-next-line no-console
    console.error(
        JSON.stringify({
            note: 'NDJSON rows printed above (one JSON object per line with hits)',
            scanned,
            rowsWithHits,
            totalStringHits,
        }),
    );
}

main().then(() => {
    process.exit(0);
}).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
});
