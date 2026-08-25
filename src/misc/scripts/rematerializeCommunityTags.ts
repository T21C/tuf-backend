import { Command } from 'commander';
import dotenv from 'dotenv';
import { initializeAssociations } from '@/models/associations.js';
import LevelTagVote from '@/models/levels/LevelTagVote.js';
import elasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import { rematerializeCommunityTagsForLevel } from '@/server/services/data/communityTagVoteService.js';
import { logger } from '@/server/services/core/LoggerService.js';

dotenv.config();
initializeAssociations();

const elasticsearch = elasticsearchService.getInstance();

async function rematerializeAll(): Promise<void> {
  const rows = await LevelTagVote.findAll({
    attributes: ['levelId'],
    group: ['levelId'],
    raw: true,
  });
  const levelIds = [...new Set(rows.map((r) => Number((r as { levelId: number }).levelId)))]
    .filter((id) => Number.isFinite(id) && id > 0);

  logger.info(`Rematerializing community tags for ${levelIds.length} level(s)`);

  const chunkSize = 50;
  for (let i = 0; i < levelIds.length; i += chunkSize) {
    const chunk = levelIds.slice(i, i + chunkSize);
    for (const levelId of chunk) {
      await rematerializeCommunityTagsForLevel(levelId);
    }
    await elasticsearch.reindexLevels(chunk);
    logger.info(`Rematerialized ${Math.min(i + chunkSize, levelIds.length)}/${levelIds.length}`);
  }
}

async function rematerializeOne(levelId: number): Promise<void> {
  await rematerializeCommunityTagsForLevel(levelId);
  await elasticsearch.reindexLevels([levelId]);
}

const program = new Command();
program
  .option('--level-id <id>', 'Rematerialize a single level')
  .action(async (opts: { levelId?: string }) => {
    try {
      if (opts.levelId) {
        const id = parseInt(opts.levelId, 10);
        if (!Number.isFinite(id) || id <= 0) {
          throw new Error('Invalid --level-id');
        }
        await rematerializeOne(id);
      } else {
        await rematerializeAll();
      }
      process.exit(0);
    } catch (error) {
      logger.error('Community tag rematerialize failed', error);
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
