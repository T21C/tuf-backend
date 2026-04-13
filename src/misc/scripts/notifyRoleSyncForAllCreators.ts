/**
 * Notify bot to re-sync Discord roles for all Creator-linked Discord users.
 *
 * Usage:
 *   npx tsx src/misc/scripts/notifyRoleSyncForAllCreators.ts --batch-size 50 --delay-ms 1500 --offset 0
 *
 * Notes:
 * - `RoleSyncService.notifyBotOfRoleSyncByDiscordIds()` is a bot notification only and is gated by NODE_ENV=production.
 * - `--offset` is a *batch index* (0-based). Example: with batch-size 50 and offset 2, we skip the first 100 Discord IDs.
 */
import dotenv from 'dotenv';
import { Command } from 'commander';
import { Op } from 'sequelize';
import { initializeAssociations } from '@/models/associations.js';
import Creator from '@/models/credits/Creator.js';
import OAuthProvider from '@/models/auth/OAuthProvider.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { roleSyncService } from '@/server/services/accounts/RoleSyncService.js';

dotenv.config();

function ensureAssociationsInitialized(): void {
  try {
    initializeAssociations();
  } catch (err) {
    // Some entrypoints initialize associations during module load; re-initializing is not idempotent in Sequelize.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Aliased associations must have unique aliases')) {
      logger.warn('[notifyRoleSyncForAllCreators] Model associations already initialized; continuing.');
      return;
    }
    throw err;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new Error('batch size must be positive');
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchAllCreatorDiscordIds(): Promise<string[]> {
  // Pull all creator->userIds, then map to Discord providerIds.
  // We keep the query patterns simple and stable (Sequelize offset/limit pagination).
  const creatorBatch = 2000;
  let offset = 0;
  const userIds: string[] = [];

  for (;;) {
    const creators = await Creator.findAll({
      where: { userId: { [Op.ne]: null } },
      attributes: ['id', 'userId'],
      order: [['id', 'ASC']],
      offset,
      limit: creatorBatch,
    });

    if (creators.length === 0) break;

    for (const c of creators) {
      const uid = c.userId;
      if (uid) userIds.push(uid);
    }

    offset += creators.length;
    logger.info(`[notifyRoleSyncForAllCreators] Loaded creators: ${offset} (userIds: ${userIds.length})`);
  }

  // Deduplicate userIds early to reduce provider lookup size.
  const uniqueUserIds = [...new Set(userIds)];
  logger.info(
    `[notifyRoleSyncForAllCreators] Creator-linked userIds: ${uniqueUserIds.length} (deduped from ${userIds.length})`
  );

  const providerBatch = 5000;
  const discordIds: string[] = [];
  const seenDiscordIds = new Set<string>();

  for (let i = 0; i < uniqueUserIds.length; i += providerBatch) {
    const userIdChunk = uniqueUserIds.slice(i, i + providerBatch);
    const providers = await OAuthProvider.findAll({
      where: {
        userId: { [Op.in]: userIdChunk },
        provider: 'discord',
      },
      attributes: ['providerId', 'userId'],
    });

    for (const p of providers) {
      const did = p.providerId;
      if (!did) continue;
      if (seenDiscordIds.has(did)) continue;
      seenDiscordIds.add(did);
      discordIds.push(did);
    }

    logger.info(
      `[notifyRoleSyncForAllCreators] Loaded Discord IDs: ${discordIds.length} (processed userIds ${Math.min(
        i + providerBatch,
        uniqueUserIds.length
      )}/${uniqueUserIds.length})`
    );
  }

  return discordIds;
}

async function run(options: {
  batchSize: number;
  delayMs: number;
  offsetBatches: number;
  dryRun: boolean;
}): Promise<void> {
  ensureAssociationsInitialized();
  const discordIds = await fetchAllCreatorDiscordIds();
  logger.info(`[notifyRoleSyncForAllCreators] Total unique Discord IDs found: ${discordIds.length}`);

  const batchSize = options.batchSize;
  const offsetBatches = options.offsetBatches;
  const startIndex = offsetBatches * batchSize;

  if (startIndex >= discordIds.length) {
    logger.warn(
      `[notifyRoleSyncForAllCreators] Offset starts beyond list (startIndex=${startIndex}, total=${discordIds.length}). Nothing to do.`
    );
    return;
  }

  const toProcess = discordIds.slice(startIndex);
  const batches = chunk(toProcess, batchSize);
  logger.info(
    `[notifyRoleSyncForAllCreators] Processing ${toProcess.length} Discord ID(s) in ${batches.length} batch(es) (batchSize=${batchSize}, offsetBatches=${offsetBatches}, delayMs=${options.delayMs})`
  );

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const batchNo = i + 1;
    const globalBatchNo = offsetBatches + batchNo;

    if (options.dryRun) {
      logger.info(
        `[notifyRoleSyncForAllCreators] Dry run: would notify batch ${batchNo}/${batches.length} (global batch index ${globalBatchNo}) with ${batch.length} Discord ID(s)`
      );
    } else {
      logger.info(
        `[notifyRoleSyncForAllCreators] Notifying batch ${batchNo}/${batches.length} (global batch index ${globalBatchNo}) with ${batch.length} Discord ID(s)`
      );
      await roleSyncService.notifyBotOfRoleSyncByDiscordIds(batch);
    }

    if (i < batches.length - 1 && options.delayMs > 0) {
      await sleep(options.delayMs);
    }
  }
}

const program = new Command();
program
  .name('notifyRoleSyncForAllCreators')
  .description('Notify Discord bot to sync roles for all creator-linked Discord accounts')
  .option('-b, --batch-size <n>', 'Discord IDs per notify call', (v) => parseInt(v, 10), 50)
  .option('-d, --delay-ms <ms>', 'Delay between notify calls (ms)', (v) => parseInt(v, 10), 1500)
  .option('-o, --offset <batches>', 'Batch index to start from (0-based)', (v) => parseInt(v, 10), 0)
  .option('--dry-run', 'Do not call the bot; only log what would happen', false)
  .action(async (opts) => {
    try {
      const batchSize = Number(opts.batchSize);
      const delayMs = Number(opts.delayMs);
      const offsetBatches = Number(opts.offset);

      if (!Number.isFinite(batchSize) || batchSize < 1) {
        throw new Error(`Invalid --batch-size: ${opts.batchSize} (use a positive integer)`);
      }
      if (!Number.isFinite(delayMs) || delayMs < 0) {
        throw new Error(`Invalid --delay-ms: ${opts.delayMs} (use a non-negative integer)`);
      }
      if (!Number.isFinite(offsetBatches) || offsetBatches < 0) {
        throw new Error(`Invalid --offset: ${opts.offset} (use a non-negative integer)`);
      }

      await run({
        batchSize,
        delayMs,
        offsetBatches,
        dryRun: Boolean(opts.dryRun),
      });
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    process.exit(0);
  });

program.parse(process.argv);

