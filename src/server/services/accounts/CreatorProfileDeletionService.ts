import LevelCredit from '@/models/levels/LevelCredit.js';
import Creator from '@/models/credits/Creator.js';
import TeamMember from '@/models/credits/TeamMember.js';
import {CreatorAlias} from '@/models/credits/CreatorAlias.js';
import cdnService from '@/server/services/core/CdnService.js';
import {logger} from '@/server/services/core/LoggerService.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import {sseManager} from '@/misc/utils/server/sse.js';
import {CacheInvalidation} from '@/server/middleware/cache.js';
import {executePermanentLevelDeleteWithSideEffects} from '@/server/domain/levels/levelPermanentDelete.js';
import Level from '@/models/levels/Level.js';

const elasticsearchService = ElasticsearchService.getInstance();

/**
 * Purges a creator profile: removes team memberships and aliases, strips or hard-deletes
 * levels per credit rules, deletes CDN banner, then destroys the `creators` row.
 *
 * Solo level: only this creator appears on `level_credits` for the level → permanent DB delete.
 * Collab: remove this creator's `LevelCredit` rows only; reindex the level.
 */
export class CreatorProfileDeletionService {
  private static instance: CreatorProfileDeletionService;

  public static getInstance(): CreatorProfileDeletionService {
    if (!CreatorProfileDeletionService.instance) {
      CreatorProfileDeletionService.instance = new CreatorProfileDeletionService();
    }
    return CreatorProfileDeletionService.instance;
  }

  public async purgeCreatorProfile(creatorId: number): Promise<void> {
    const credits = await LevelCredit.findAll({
      where: {creatorId},
      attributes: ['levelId', 'creatorId'],
      raw: true,
    });

    const levelIds = [...new Set(credits.map((c: {levelId: number}) => c.levelId))];

    for (const levelId of levelIds) {
      const allForLevel = await LevelCredit.findAll({
        where: {levelId},
        attributes: ['creatorId'],
        raw: true,
      });
      const distinctCreators = new Set(allForLevel.map((r: {creatorId: number}) => r.creatorId));
      const solo = distinctCreators.size === 1 && distinctCreators.has(creatorId);

      if (solo) {
        await executePermanentLevelDeleteWithSideEffects(
          levelId,
          {requireSoftDeleted: false},
          {
            elasticsearchDeleteLevel: async (id) => {
              await elasticsearchService.deleteLevel({id} as Level);
            },
            broadcastAndInvalidate: async ({levelId: lid, affectedPlayerIds}) => {
              sseManager.broadcast({type: 'levelUpdate'});
              sseManager.broadcast({type: 'ratingUpdate'});
              await CacheInvalidation.invalidateTags([
                `level:${lid}`,
                'levels:all',
                'Passes',
              ]);
              if (affectedPlayerIds.length > 0) {
                await elasticsearchService.reindexPlayers(affectedPlayerIds);
              }
            },
          },
        );
      } else {
        await LevelCredit.destroy({
          where: {levelId, creatorId},
        });
        try {
          await elasticsearchService.indexLevel(levelId);
        } catch (e) {
          logger.warn('[CreatorProfileDeletion] indexLevel after credit strip failed', {
            levelId,
            message: e instanceof Error ? e.message : String(e),
          });
        }
        await CacheInvalidation.invalidateTags([`level:${levelId}`, 'levels:all']).catch(() => undefined);
      }
    }

    await TeamMember.destroy({where: {creatorId}});
    await CreatorAlias.destroy({where: {creatorId}});

    const creator = await Creator.findByPk(creatorId);
    if (creator?.customBannerId) {
      try {
        if (await cdnService.checkFileExists(creator.customBannerId)) {
          await cdnService.deleteFile(creator.customBannerId);
        }
      } catch (e) {
        logger.warn('[CreatorProfileDeletion] CDN banner delete failed', {
          creatorId,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }

    await Creator.destroy({where: {id: creatorId}});

    try {
      await elasticsearchService.reindexCreators([creatorId]);
    } catch (e) {
      logger.warn('[CreatorProfileDeletion] reindexCreators failed', {
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Clear user link only; keep creator row and level credits.
   */
  public async unlinkCreatorFromUser(creatorId: number): Promise<void> {
    await Creator.update({userId: null}, {where: {id: creatorId}});
  }
}
