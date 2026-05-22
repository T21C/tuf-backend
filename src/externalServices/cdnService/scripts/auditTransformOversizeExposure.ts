/**
 * Scan LEVELZIP rows where GET /:fileId/transform can still run a full LevelDict parse
 * despite oversized ingest limits (read-only).
 *
 * Pair with {@link fixTransformOversizeExposure.ts} (`--apply`) to close the transform gate
 * and rebuild minimal oversized cache — same workflow as auditPassJudgements scan vs clamp.
 *
 * Usage (from server/):
 *   npx tsx src/externalServices/cdnService/scripts/auditTransformOversizeExposure.ts
 *   npx tsx src/externalServices/cdnService/scripts/auditTransformOversizeExposure.ts --help
 *   npx tsx src/externalServices/cdnService/scripts/auditTransformOversizeExposure.ts --only-exposed
 *   npx tsx src/externalServices/cdnService/scripts/auditTransformOversizeExposure.ts --verify-spaces --out-json ./exposed.json
 *   npx tsx src/externalServices/cdnService/scripts/fixTransformOversizeExposure.ts --apply
 */

import {parseArgs} from 'node:util';
import {writeFile} from 'node:fs/promises';
import dotenv from 'dotenv';

dotenv.config();

import {getSequelizeForModelGroup} from '@/config/db.js';
import {initializeAssociations} from '@/models/associations.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {spacesStorage} from '../infra/storage/spacesStorage.js';
import {
    MAX_LEVEL_FILE_SIZE_FOR_PARSE,
    MAX_LEVEL_TILECOUNT_FOR_FULL_PARSE,
} from '../domain/level/levelParseLimits.js';
import {scanTransformOversizeExposure} from '../domain/level/transformOversizeExposureAudit.js';

initializeAssociations();

const cdnSequelize = getSequelizeForModelGroup('cdn');

interface CliOptions {
    fileId?: string;
    offset: number;
    limit?: number;
    batchSize: number;
    onlyExposed: boolean;
    verifySpaces: boolean;
    withLevelIds: boolean;
    minFileSizeBytes: number;
    minTilecount: number;
    outJson?: string;
}

function printHelp(): void {
    const text = `
auditTransformOversizeExposure.ts

Read-only scan for LEVELZIP rows where transform can still load the target .adofai with
LevelDict (OOM risk on huge charts). Writes JSON summary to stdout unless --out-json is set.

To repair flagged rows, use the sibling fix script (dry-run by default):
  npx tsx src/externalServices/cdnService/scripts/fixTransformOversizeExposure.ts
  npx tsx src/externalServices/cdnService/scripts/fixTransformOversizeExposure.ts --apply

FLAGS
  --help, -h
    Show this help.

  --file-id <uuid>
    Audit a single cdn_files.id.

  --offset <n>
    Skip first n LEVELZIP rows (order by id). Default: 0

  --limit <n>
    Max rows to scan (omit = all).

  --batch-size <n>
    SELECT batch size. Default: 500

  --only-exposed
    Output only crashRisk hits in the hits array.

  --verify-spaces
    HEAD target .adofai in Spaces (slower; adds spaces_* reasons).

  --with-level-ids
    Attach levels.id for each exposed hit.

  --min-size-bytes <n>
    File size threshold (default ${MAX_LEVEL_FILE_SIZE_FOR_PARSE}).

  --min-tilecount <n>
    Tile count threshold (default ${MAX_LEVEL_TILECOUNT_FOR_FULL_PARSE}).

  --out-json <path>
    Write full scan result JSON to a file instead of only stdout.

EXAMPLES
  Scan all exposed rows:
    npx tsx src/externalServices/cdnService/scripts/auditTransformOversizeExposure.ts --only-exposed

  Export for review:
    npx tsx src/externalServices/cdnService/scripts/auditTransformOversizeExposure.ts --only-exposed --out-json ./transform-exposed.json

  Single file:
    npx tsx src/externalServices/cdnService/scripts/auditTransformOversizeExposure.ts --file-id <uuid> --with-level-ids
`.trim();

    // eslint-disable-next-line no-console
    console.log(text);
}

async function runScript(): Promise<void> {
    const {values} = parseArgs({
        options: {
            help: {type: 'boolean', short: 'h', default: false},
            'file-id': {type: 'string'},
            offset: {type: 'string', default: '0'},
            limit: {type: 'string'},
            'batch-size': {type: 'string', default: '500'},
            'only-exposed': {type: 'boolean', default: false},
            'verify-spaces': {type: 'boolean', default: false},
            'with-level-ids': {type: 'boolean', default: false},
            'min-size-bytes': {type: 'string', default: String(MAX_LEVEL_FILE_SIZE_FOR_PARSE)},
            'min-tilecount': {type: 'string', default: String(MAX_LEVEL_TILECOUNT_FOR_FULL_PARSE)},
            'out-json': {type: 'string'},
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

    const minFileSizeBytes = parseInt(String(values['min-size-bytes']), 10);
    if (!Number.isFinite(minFileSizeBytes) || minFileSizeBytes < 1) {
        throw new Error('Invalid --min-size-bytes');
    }

    const minTilecount = parseInt(String(values['min-tilecount']), 10);
    if (!Number.isFinite(minTilecount) || minTilecount < 1) {
        throw new Error('Invalid --min-tilecount');
    }

    const opts: CliOptions = {
        fileId: values['file-id']?.trim() || undefined,
        offset,
        limit,
        batchSize,
        onlyExposed: Boolean(values['only-exposed']),
        verifySpaces: Boolean(values['verify-spaces']),
        withLevelIds: Boolean(values['with-level-ids']),
        minFileSizeBytes,
        minTilecount,
        outJson: values['out-json']?.trim() || undefined,
    };

    const t0 = Date.now();
    await cdnSequelize.authenticate();
    logger.info('DB OK', {mode: 'scan'});

    const output = await scanTransformOversizeExposure({
        fileId: opts.fileId ?? null,
        offset: opts.offset,
        limit: opts.limit ?? null,
        batchSize: opts.batchSize,
        onlyExposed: opts.onlyExposed,
        verifySpaces: opts.verifySpaces,
        withLevelIds: opts.withLevelIds,
        minFileSizeBytes: opts.minFileSizeBytes,
        minTilecount: opts.minTilecount,
        getSpacesTargetSizeBytes: opts.verifySpaces
            ? async (targetPath) => {
                  const head = await spacesStorage.getFileMetadata(targetPath);
                  return typeof head?.ContentLength === 'number' ? head.ContentLength : null;
              }
            : undefined,
    });

    const json = JSON.stringify(output, null, 2);
    if (opts.outJson) {
        await writeFile(opts.outJson, json, 'utf8');
        logger.info('Wrote JSON', {path: opts.outJson, crashRiskCount: output.crashRiskCount});
    } else {
        // eslint-disable-next-line no-console
        console.log(json);
    }

    logger.info('Scan complete', {
        elapsedMs: Date.now() - t0,
        scanned: output.scanned,
        crashRiskCount: output.crashRiskCount,
    });
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
