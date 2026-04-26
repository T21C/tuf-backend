/**
 * Backfill `levels.createdAt` when it was bulk-set to a DB-init timestamp.
 *
 * For each level with a `videoLink`, derives an upload time from:
 * - Bilibili: `api.bilibili.com/x/web-interface/view` (same as media route; no YouTube quota).
 * - Other hosts (YouTube, etc.): `yt-dlp` JSON (`timestamp` / `upload_date`) via subprocess — avoids YouTube Data API quota.
 *
 * Then: `best = min(videoUploadTime, oldestPassVidUploadTime)` (ignoring nulls).
 * If `best` is set, updates `levels.createdAt` to that instant (UTC stored as MySQL DATETIME).
 *
 * Safety: bulk runs require `--match-created-date` (YYYY-MM-DD) or `--allow-any-created-at`.
 *
 * Usage (from server/):
 *   npx tsx src/misc/scripts/backfillLevelCreatedAtFromVideoAndPasses.ts --dry-run --match-created-date 2025-01-15 --limit 20
 *   npx tsx src/misc/scripts/backfillLevelCreatedAtFromVideoAndPasses.ts --level-id 12345 --dry-run
 *   npx tsx src/misc/scripts/backfillLevelCreatedAtFromVideoAndPasses.ts --match-created-date 2025-01-15 --ytdlp-path "C:\\path\\yt-dlp.exe" --concurrency 4
 */

import {parseArgs} from 'node:util';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {homedir} from 'node:os';
import dotenv from 'dotenv';
import {QueryTypes} from 'sequelize';

dotenv.config();

import sequelize from '@/config/db.js';
import Level from '@/models/levels/Level.js';
import {initializeAssociations} from '@/models/associations.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {getBilibiliVideoDetails} from '@/misc/utils/data/videoDetailParser.js';

initializeAssociations();

const execFileAsync = promisify(execFile);

/** Pass model default placeholder when vidUploadTime missing — exclude from MIN. */
const PASS_VID_PLACEHOLDER = '2023-07-27 07:27:27';

interface LevelRow {
  id: number;
  videoLink: string;
  createdAt: Date | string | null;
  oldestPassUpload: Date | string | null;
}

function isYoutubeUrl(url: string): boolean {
  return /youtu\.be|youtube\.com/i.test(url);
}

function isBilibiliUrl(url: string): boolean {
  return /bilibili\.com\/video\//i.test(url);
}

function parseMysqlDate(d: unknown): Date | null {
  if (d == null || d === '') return null;
  if (d instanceof Date && !Number.isNaN(d.getTime())) return d;
  const t = new Date(String(d));
  return Number.isNaN(t.getTime()) ? null : t;
}

function minValidDate(...candidates: Array<Date | null | undefined>): Date | null {
  const ok = candidates.filter((x): x is Date => x instanceof Date && !Number.isNaN(x.getTime()));
  if (ok.length === 0) return null;
  return new Date(Math.min(...ok.map((d) => d.getTime())));
}

function uploadDateFromYtdlpJson(obj: Record<string, unknown>): Date | null {
  const ts = obj.timestamp ?? obj.upload_timestamp ?? obj.release_timestamp;
  if (typeof ts === 'number' && Number.isFinite(ts) && ts > 946684800) {
    return new Date(Math.floor(ts) * 1000);
  }
  const ud = obj.upload_date ?? obj.release_date;
  if (typeof ud === 'string' && /^\d{8}$/.test(ud)) {
    const y = Number(ud.slice(0, 4));
    const m = Number(ud.slice(4, 6));
    const day = Number(ud.slice(6, 8));
    if (y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && day >= 1 && day <= 31) {
      return new Date(Date.UTC(y, m - 1, day, 12, 0, 0));
    }
  }
  return null;
}

async function runYtDlpUploadDate(
  videoUrl: string,
  ytdlpBinary: string,
  timeoutMs: number,
): Promise<Date | null> {
  const args = [
    '--no-playlist',
    '--skip-download',
    '--no-warnings',
    '--quiet',
    '--dump-json',
    '--',
    videoUrl,
  ];
  try {
    const {stdout, stderr} = await execFileAsync(ytdlpBinary, args, {
      maxBuffer: 32 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
    });
    if (stderr && /ERROR/i.test(stderr)) {
      logger.debug('[ytdlp] stderr', {snippet: stderr.slice(0, 400)});
    }
    const t = stdout.trim();
    const jsonText = t.startsWith('{') ? t : t.split(/\r?\n/).find((l) => l.startsWith('{')) ?? '';
    if (!jsonText) return null;
    const obj = JSON.parse(jsonText) as Record<string, unknown>;
    return uploadDateFromYtdlpJson(obj);
  } catch (e) {
    logger.debug('[ytdlp] failed', {
      url: videoUrl.slice(0, 80),
      err: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

async function videoUploadDate(
  videoLink: string,
  ytdlpBinary: string,
  ytdlpTimeoutMs: number,
): Promise<Date | null> {
  const url = videoLink.trim();
  if (!url) return null;

  if (isBilibiliUrl(url)) {
    const details = await getBilibiliVideoDetails(url);
    if (!details?.timestamp) return null;
    const d = new Date(details.timestamp);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  if (isYoutubeUrl(url)) {
    return runYtDlpUploadDate(url, ytdlpBinary, ytdlpTimeoutMs);
  }

  // Other hosts: try yt-dlp (many extractors); avoids coupling to site-specific APIs here.
  return runYtDlpUploadDate(url, ytdlpBinary, ytdlpTimeoutMs);
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const n = Math.min(Math.max(1, concurrency), items.length);
  let index = 0;
  const worker = async () => {
    while (true) {
      const i = index++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  };
  await Promise.all(Array.from({length: n}, () => worker()));
}

interface CliOptions {
  dryRun: boolean;
  levelId?: number;
  limit?: number;
  afterId: number;
  concurrency: number;
  matchCreatedDate?: string;
  allowAnyCreatedAt: boolean;
  ytdlpPath: string;
  ytdlpTimeoutMs: number;
  onlyIfEarlierThanCurrent: boolean;
}

async function fetchBatch(
  afterId: number,
  limit: number,
  matchCreatedDate?: string,
  levelId?: number,
): Promise<LevelRow[]> {
  if (levelId != null && Number.isFinite(levelId)) {
    const rows = (await sequelize.query(
      `
      SELECT
        l.id AS id,
        l.videoLink AS videoLink,
        l.createdAt AS createdAt,
        (
          SELECT MIN(p.vidUploadTime)
          FROM passes p
          WHERE p.levelId = l.id
            AND IFNULL(p.isDeleted, 0) = 0
            AND IFNULL(p.isHidden, 0) = 0
            AND p.vidUploadTime IS NOT NULL
            AND p.vidUploadTime <> :placeholder
            AND p.vidUploadTime > '2000-01-01'
            AND p.vidUploadTime < '2035-01-01'
        ) AS oldestPassUpload
      FROM levels l
      WHERE l.id = :levelId
        AND IFNULL(l.isDeleted, 0) = 0
        AND l.videoLink IS NOT NULL
        AND TRIM(l.videoLink) <> ''
      `,
      {
        replacements: {levelId, placeholder: PASS_VID_PLACEHOLDER},
        type: QueryTypes.SELECT,
      },
    )) as LevelRow[];
    return rows;
  }

  const dateClause =
    matchCreatedDate != null && matchCreatedDate !== ''
      ? 'AND DATE(l.createdAt) = :matchDate'
      : '';

  const rows = (await sequelize.query(
    `
    SELECT
      l.id AS id,
      l.videoLink AS videoLink,
      l.createdAt AS createdAt,
      (
        SELECT MIN(p.vidUploadTime)
        FROM passes p
        WHERE p.levelId = l.id
          AND IFNULL(p.isDeleted, 0) = 0
          AND IFNULL(p.isHidden, 0) = 0
          AND p.vidUploadTime IS NOT NULL
          AND p.vidUploadTime <> :placeholder
          AND p.vidUploadTime > '2000-01-01'
          AND p.vidUploadTime < '2035-01-01'
      ) AS oldestPassUpload
    FROM levels l
    WHERE l.id > :afterId
      AND IFNULL(l.isDeleted, 0) = 0
      AND l.videoLink IS NOT NULL
      AND TRIM(l.videoLink) <> ''
      ${dateClause}
    ORDER BY l.id ASC
    LIMIT :limit
    `,
    {
      replacements: {
        afterId,
        limit,
        placeholder: PASS_VID_PLACEHOLDER,
        ...(matchCreatedDate ? {matchDate: matchCreatedDate} : {}),
      },
      type: QueryTypes.SELECT,
    },
  )) as LevelRow[];

  return rows;
}

async function processOne(row: LevelRow, opts: CliOptions): Promise<'updated' | 'skipped' | 'failed'> {
  const currentCreated = parseMysqlDate(row.createdAt);
  const oldestPass = parseMysqlDate(row.oldestPassUpload);

  let videoAt: Date | null;
  try {
    videoAt = await videoUploadDate(row.videoLink, opts.ytdlpPath, opts.ytdlpTimeoutMs);
  } catch (e) {
    logger.error(`Level ${row.id}: video fetch threw`, {
      error: e instanceof Error ? e.message : String(e),
    });
    return 'failed';
  }

  const best = minValidDate(videoAt, oldestPass);
  if (!best) {
    logger.info(`Level ${row.id}: skip (no video date and no pass vidUploadTime)`, {
      videoLink: row.videoLink.slice(0, 80),
    });
    return 'skipped';
  }

  if (opts.onlyIfEarlierThanCurrent && currentCreated && best.getTime() >= currentCreated.getTime()) {
    logger.info(`Level ${row.id}: skip (best not earlier than current createdAt)`);
    return 'skipped';
  }

  if (opts.dryRun) {
    logger.info(`[DRY RUN] Level ${row.id}: would set createdAt`, {
      from: currentCreated?.toISOString() ?? null,
      to: best.toISOString(),
      videoAt: videoAt?.toISOString() ?? null,
      oldestPass: oldestPass?.toISOString() ?? null,
    });
    return 'updated';
  }

  try {
    await Level.update(
      {createdAt: best},
      {
        where: {id: row.id},
        fields: ['createdAt'],
        hooks: false,
      },
    );
    logger.info(`Level ${row.id}: updated createdAt`, {
      to: best.toISOString(),
      videoAt: videoAt?.toISOString() ?? null,
      oldestPass: oldestPass?.toISOString() ?? null,
    });
    return 'updated';
  } catch (e) {
    logger.error(`Level ${row.id}: DB update failed`, {
      error: e instanceof Error ? e.message : String(e),
    });
    return 'failed';
  }
}

async function run(opts: CliOptions): Promise<void> {
  await sequelize.authenticate();
  logger.info('DB OK', {
    dryRun: opts.dryRun,
    ytdlpPath: opts.ytdlpPath,
    concurrency: opts.concurrency,
  });

  if (
    opts.levelId == null &&
    !opts.matchCreatedDate &&
    !opts.allowAnyCreatedAt
  ) {
    throw new Error(
      'Refusing to run without scope: pass --level-id <id>, or --match-created-date YYYY-MM-DD, or --allow-any-created-at',
    );
  }

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  if (opts.levelId != null) {
    const batch = await fetchBatch(0, 1, undefined, opts.levelId);
    if (batch.length === 0) {
      logger.warn('No matching level');
      return;
    }
    const r = await processOne(batch[0], opts);
    if (r === 'updated') updated++;
    else if (r === 'skipped') skipped++;
    else failed++;
    logger.info('Done (single)', {updated, skipped, failed});
    return;
  }

  const maxTotal = opts.limit ?? Number.MAX_SAFE_INTEGER;
  let processed = 0;
  let afterId = opts.afterId;

  while (processed < maxTotal) {
    const remaining = maxTotal - processed;
    const batchSize = Math.min(200, remaining);
    const batch = await fetchBatch(afterId, batchSize, opts.matchCreatedDate, undefined);
    if (batch.length === 0) break;

    afterId = batch[batch.length - 1].id;

    await mapWithConcurrency(batch, opts.concurrency, async (row) => {
      try {
        const r = await processOne(row, opts);
        if (r === 'updated') updated++;
        else if (r === 'skipped') skipped++;
        else failed++;
      } catch (e) {
        failed++;
        logger.error(`Level ${row.id} worker error`, {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    });

    processed += batch.length;
    if (batch.length < batchSize) break;
  }

  logger.info('Done', {updated, skipped, failed, dryRun: opts.dryRun});
}

function defaultYtDlpPath(): string {
  const env = process.env.YTDLP_PATH;
  if (env && env.trim()) return env.trim();
  if (process.platform === 'win32') {
    return path.join(process.cwd(), 'yt-dlp.exe');
  }
  return 'yt-dlp';
}

/** `child_process.execFile` does not expand shell `~` — resolve it here. */
function resolveYtDlpPath(p: string): string {
  const t = p.trim();
  if (t.startsWith('~/')) {
    return path.join(homedir(), t.slice(2));
  }
  if (t === '~') {
    return homedir();
  }
  return t;
}

async function main() {
  const {values} = parseArgs({
    options: {
      'dry-run': {type: 'boolean', default: false},
      'level-id': {type: 'string'},
      limit: {type: 'string'},
      'after-id': {type: 'string'},
      concurrency: {type: 'string'},
      'match-created-date': {type: 'string'},
      'allow-any-created-at': {type: 'boolean', default: false},
      'ytdlp-path': {type: 'string'},
      'ytdlp-timeout-ms': {type: 'string'},
      'only-if-earlier': {type: 'boolean', default: false},
    },
    allowPositionals: false,
  });

  const levelIdRaw = values['level-id'];
  const levelId =
    levelIdRaw != null && levelIdRaw !== '' ? parseInt(String(levelIdRaw), 10) : undefined;

  const opts: CliOptions = {
    dryRun: Boolean(values['dry-run']),
    levelId: Number.isFinite(levelId) ? levelId : undefined,
    limit: values.limit != null ? parseInt(String(values.limit), 10) : undefined,
    afterId:
      values['after-id'] != null && values['after-id'] !== ''
        ? parseInt(String(values['after-id']), 10)
        : 0,
    concurrency:
      values.concurrency != null && values.concurrency !== ''
        ? Math.max(1, parseInt(String(values.concurrency), 10))
        : 4,
    matchCreatedDate: values['match-created-date']?.trim() || undefined,
    allowAnyCreatedAt: Boolean(values['allow-any-created-at']),
    ytdlpPath: resolveYtDlpPath(values['ytdlp-path']?.trim() || defaultYtDlpPath()),
    ytdlpTimeoutMs:
      values['ytdlp-timeout-ms'] != null && values['ytdlp-timeout-ms'] !== ''
        ? Math.max(5000, parseInt(String(values['ytdlp-timeout-ms']), 10))
        : 120_000,
    onlyIfEarlierThanCurrent: Boolean(values['only-if-earlier']),
  };

  if (opts.limit != null && (!Number.isFinite(opts.limit) || opts.limit < 1)) {
    throw new Error('Invalid --limit');
  }
  if (!Number.isFinite(opts.afterId) || opts.afterId < 0) {
    throw new Error('Invalid --after-id');
  }
  if (opts.matchCreatedDate && !/^\d{4}-\d{2}-\d{2}$/.test(opts.matchCreatedDate)) {
    throw new Error('--match-created-date must be YYYY-MM-DD');
  }

  try {
    await run(opts);
  } finally {
    await sequelize.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
