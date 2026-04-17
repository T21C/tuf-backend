/**
 * Migrate difficulty icons (and legacy icons) from local disk cache to the CDN.
 *
 * For every Difficulty row whose `icon` / `legacyIcon` is a non-CDN URL, this
 * script reads the corresponding file from the local icon cache, uploads it
 * to the CDN as a DIFFICULTY_ICON, and updates the row with the new CDN URL.
 *
 * The script never deletes the on-disk files: they stay as a safety net while
 * the rollout is verified. Re-running the script is safe - rows that already
 * hold a CDN URL are skipped.
 *
 * Usage:
 *   npx tsx src/misc/scripts/migrateDifficultyIconsToCdn.ts [--dry-run] [--cache-path <dir>]
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { Command } from 'commander';
// Importing from @/models/index.js pulls in all models and runs
// initializeAssociations() as a module-load side effect (see models/index.ts).
// Do NOT call initializeAssociations() again or Sequelize throws
// "alias refreshTokens used in two separate associations".
import '@/models/index.js';
import Difficulty from '@/models/levels/Difficulty.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { isCdnUrl } from '@/misc/utils/Utility.js';
import cdnService from '@/server/services/core/CdnService.js';
import { updateDifficultiesHash } from '@/server/routes/v2/database/difficulties.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface CliOptions {
  dryRun: boolean;
  cachePath: string;
}

function parseArgs(): CliOptions {
  const program = new Command();
  program
    .option('--dry-run', 'Print what would happen without uploading or writing to the DB', false)
    .option('--cache-path <dir>', 'Override the on-disk icon cache root (defaults to $CACHE_PATH/icons or ./cache/icons)')
    .parse(process.argv);

  const opts = program.opts<{ dryRun?: boolean; cachePath?: string }>();
  const defaultCache = process.env.CACHE_PATH || path.join(process.cwd(), 'cache');
  return {
    dryRun: Boolean(opts.dryRun),
    cachePath: opts.cachePath ? path.resolve(opts.cachePath) : path.join(defaultCache, 'icons'),
  };
}

// Parse the trailing filename (with extension) from a legacy disk-cache icon URL.
function extractFilenameFromLegacyUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const lastSegment = parsed.pathname.split('/').filter(Boolean).pop();
    return lastSegment || null;
  } catch {
    // Not a URL - some rows may already be bare filenames
    const segment = url.split('/').filter(Boolean).pop();
    return segment || null;
  }
}

interface MigrationTarget {
  difficulty: Difficulty;
  kind: 'icon' | 'legacyIcon';
  url: string;
}

async function migrateOne(
  target: MigrationTarget,
  cacheRoot: string,
  dryRun: boolean,
): Promise<'migrated' | 'skipped' | 'failed'> {
  const { difficulty, kind, url } = target;
  const label = `Difficulty ${difficulty.id} (${difficulty.name}) [${kind}]`;

  const filename = extractFilenameFromLegacyUrl(url);
  if (!filename) {
    logger.warn(`[skip] ${label}: could not parse filename from URL "${url}"`);
    return 'skipped';
  }

  const filePath = path.join(cacheRoot, filename);
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(filePath);
  } catch (err) {
    logger.warn(`[skip] ${label}: disk file not found at ${filePath} (${err instanceof Error ? err.message : String(err)})`);
    return 'skipped';
  }

  if (dryRun) {
    logger.info(`[dry-run] ${label}: would upload ${filePath} (${buffer.length} bytes) to CDN`);
    return 'migrated';
  }

  try {
    const result = await cdnService.uploadDifficultyIcon(buffer, filename);
    const cdnUrl = result.urls.original || result.urls.medium;
    if (!cdnUrl) {
      logger.error(`[fail] ${label}: CDN upload returned no usable URL`, result);
      return 'failed';
    }

    await difficulty.update({ [kind]: cdnUrl } as any);
    logger.info(`[ok]  ${label}: ${url} -> ${cdnUrl}`);
    return 'migrated';
  } catch (err) {
    logger.error(`[fail] ${label}: upload or DB update failed`, err instanceof Error ? err.message : err);
    return 'failed';
  }
}

async function main(): Promise<void> {
  const opts = parseArgs();
  logger.info(`Starting difficulty icon CDN migration`, {
    dryRun: opts.dryRun,
    cachePath: opts.cachePath,
    scriptDir: __dirname,
  });

  const difficulties = await Difficulty.findAll({
    attributes: ['id', 'name', 'icon', 'legacyIcon'],
    order: [['id', 'ASC']],
  });

  const targets: MigrationTarget[] = [];
  for (const d of difficulties) {
    if (d.icon && !isCdnUrl(d.icon)) {
      targets.push({ difficulty: d, kind: 'icon', url: d.icon });
    }
    if (d.legacyIcon && !isCdnUrl(d.legacyIcon)) {
      targets.push({ difficulty: d, kind: 'legacyIcon', url: d.legacyIcon });
    }
  }

  logger.info(`Found ${targets.length} icon(s) to migrate across ${difficulties.length} difficulty row(s)`);

  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  for (const target of targets) {
    const outcome = await migrateOne(target, opts.cachePath, opts.dryRun);
    if (outcome === 'migrated') migrated++;
    else if (outcome === 'skipped') skipped++;
    else failed++;
  }

  if (!opts.dryRun && migrated > 0) {
    try {
      await updateDifficultiesHash();
      logger.info('Difficulties hash refreshed');
    } catch (err) {
      logger.error('Failed to refresh difficulties hash after migration', err);
    }
  }

  logger.info(`Migration finished`, { migrated, skipped, failed, total: targets.length });
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    logger.error('Difficulty icon migration crashed:', err);
    process.exit(1);
  });
