import Level from '@/models/levels/Level.js';
import Pass from '@/models/passes/Pass.js';
import Player from '@/models/players/Player.js';
import Curation from '@/models/curations/Curation.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { LEVEL_INCLUDES } from '@/server/services/elasticsearch/sequelizeIncludes.js';

export async function fetchLevelWithRelations(levelId: number): Promise<Level | null> {
  logger.debug(`Getting level with relations for level ${levelId}`);
  const level = await Level.findByPk(levelId, { include: LEVEL_INCLUDES });
  if (!level) return null;
  const clears = await Pass.count({
    where: {
      levelId: levelId,
      isDeleted: false,
      isHidden: false,
    },
    include: [
      {
        model: Player,
        as: 'player',
        where: {
          isBanned: false,
        },
      },
    ],
  });
  const _curations = (level as { curations?: Curation[] }).curations;
  logger.debug(`Level ${level.id} curationtype: ${_curations?.[0]?.types?.[0]?.name}`);
  level.clears = clears;
  logger.debug(`Level ${level.id} has ${clears} clears`);
  return level;
}
