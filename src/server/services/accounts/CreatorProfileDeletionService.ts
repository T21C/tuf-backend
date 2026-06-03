import LevelCredit from '@/models/levels/LevelCredit.js';
import Creator from '@/models/credits/Creator.js';
import TeamMember from '@/models/credits/TeamMember.js';
import {CreatorAlias} from '@/models/credits/CreatorAlias.js';
import Pass from '@/models/passes/Pass.js';
import cdnService from '@/server/services/core/CdnService.js';
import {logger} from '@/server/services/core/LoggerService.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import {sseManager} from '@/misc/utils/server/sse.js';
import {CacheInvalidation} from '@/server/middleware/cache.js';
import Level from '@/models/levels/Level.js';

const elasticsearchService = ElasticsearchService.getInstance();

/**
 * Purges a creator profile: removes team memberships and aliases, strips credits,
 * soft-deletes solo levels (preserves chart files), deletes CDN banner, then destroys
 * the `creators` row.
 *
 * - Solo level: strip credits, then soft-delete (`isDeleted` + `isHidden`).
 * - Collab: remove this creator's `LevelCredit` rows only; reindex the level.
 */
export class CreatorProfileDeletionService {
  private static instance: CreatorProfileDeletionService;

  public static getInstance(): CreatorProfileDeletionService {
    if (!CreatorProfileDeletionService.instance) {
      CreatorProfileDeletionService.instance = new CreatorProfileDeletionService();
    }
    return CreatorProfileDeletionService.instance;
  }

  private async stripCreatorCreditsAndReindex(
    levelId: number,
    creatorId: number,
  ): Promise<void> {
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

  private async softDeleteLevelWithSideEffects(levelId: number): Promise<void> {
    const passRows = await Pass.findAll({
      where: {levelId},
      attributes: ['playerId'],
    });
    const affectedPlayerIds = Array.from(
      new Set(passRows.map((p) => p.playerId).filter((x): x is number => typeof x === 'number')),
    );

    await Level.update({isDeleted: true, isHidden: true}, {where: {id: levelId}});

    try {
      await elasticsearchService.indexLevel(levelId);
    } catch (e) {
      logger.warn('[CreatorProfileDeletion] indexLevel after soft delete failed', {
        levelId,
        message: e instanceof Error ? e.message : String(e),
      });
    }

    sseManager.broadcast({type: 'levelUpdate'});
    sseManager.broadcast({type: 'ratingUpdate'});
    await CacheInvalidation.invalidateTags([`level:${levelId}`, 'levels:all', 'Passes']).catch(
      () => undefined,
    );

    if (affectedPlayerIds.length > 0) {
      try {
        await elasticsearchService.reindexPlayers(affectedPlayerIds);
      } catch (e) {
        logger.warn('[CreatorProfileDeletion] reindexPlayers after soft delete failed', {
          levelId,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
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
        await this.stripCreatorCreditsAndReindex(levelId, creatorId);
        await this.softDeleteLevelWithSideEffects(levelId);
      } else {
        await this.stripCreatorCreditsAndReindex(levelId, creatorId);
      }
    }

    await TeamMember.destroy({where: {creatorId}});
    await CreatorAlias.destroy({where: {creatorId}});

    const creator = await Creator.findByPk(creatorId);
    const surfaceAssetIds: string[] = [];
    if (
      creator?.profileHeaderSurfaceImageAssets &&
      typeof creator.profileHeaderSurfaceImageAssets === 'object' &&
      !Array.isArray(creator.profileHeaderSurfaceImageAssets)
    ) {
      for (const row of Object.values(creator.profileHeaderSurfaceImageAssets)) {
        if (row && typeof row === 'object' && typeof row.assetId === 'string' && row.assetId.length) {
          surfaceAssetIds.push(row.assetId);
        }
      }
    }
    for (const fileId of [creator?.customBannerId, ...surfaceAssetIds]) {
      if (!fileId) continue;
      try {
        if (await cdnService.checkFileExists(fileId)) {
          await cdnService.deleteFile(fileId);
        }
      } catch (e) {
        logger.warn('[CreatorProfileDeletion] CDN profile asset delete failed', {
          creatorId,
          fileId,
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
