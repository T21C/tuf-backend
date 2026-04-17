import { Router, Request, Response } from 'express';
import { Auth } from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { standardErrorResponses500, idParamSpec } from '@/server/schemas/v2/database/passes/index.js';
import Pass from '@/models/passes/Pass.js';
import Player from '@/models/players/Player.js';
import Level from '@/models/levels/Level.js';
import Judgement from '@/models/passes/Judgement.js';
import Difficulty from '@/models/levels/Difficulty.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { getIO } from '@/misc/utils/server/socket.js';
import sequelize from '@/config/db.js';
import { updateWorldsFirstStatus } from './index.js';
import { safeTransactionRollback, sanitizeTextInput } from '@/misc/utils/Utility.js';
import { calcAcc, IJudgements } from '@/misc/utils/pass/CalcAcc.js';
import { getScoreV2 } from '@/misc/utils/pass/CalcScore.js';
import { sanitizeJudgements } from '@/misc/utils/pass/SanitizeJudgements.js';
import { PlayerStatsService } from '@/server/services/core/PlayerStatsService.js';
import { sseManager } from '@/misc/utils/server/sse.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import { User } from '@/models/index.js';
import Creator from '@/models/credits/Creator.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import Team from '@/models/credits/Team.js';

const playerStatsService = PlayerStatsService.getInstance();
const elasticsearchService = ElasticsearchService.getInstance();
const router = Router();

router.put(
  '/:id([0-9]{1,20})',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'updatePass',
    summary: 'Update pass',
    description: 'Update a pass by ID (super admin). Body: levelId, vidUploadTime, speed, feelingRating, vidTitle, videoLink, is12K, is16K, isNoHoldTap, accuracy, scoreV2, isDeleted, judgements, playerId, isAnnounced, isDuplicate. Recalculates accuracy/score when judgements provided.',
    tags: ['Passes'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    requestBody: { description: 'Pass fields to update', schema: { type: 'object' } },
    responses: { 200: { description: 'Updated pass' }, 404: { description: 'Pass not found' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
    let transaction: any;
    try {
      transaction = await sequelize.transaction();
      const {id} = req.params;
      let {
        levelId,
        vidUploadTime,
        speed,
        feelingRating,
        vidTitle,
        videoLink,
        is12K,
        is16K,
        isNoHoldTap,
        accuracy,
        scoreV2,
        isDeleted,
        judgements,
        playerId,
        isAnnounced,
        isDuplicate,
      } = req.body;


      // First fetch the pass with its current level data
      const pass = await Pass.findOne({
        where: {id: parseInt(id)},
        include: [
          {
            model: Level,
            as: 'level',
            include: [
              {
                model: Difficulty,
                as: 'difficulty',
                attributes: ['baseScore'],
              },
              {
                model: LevelCredit,
                as: 'levelCredits',
                include: [{
                  model: Creator,
                  as: 'creator',
                }],
              },
              {
                model: Team,
                as: 'teamObject',
              },
            ],
          },
          {
            model: Player,
            as: 'player',
          },
          {
            model: Judgement,
            as: 'judgements',
          },
        ],
        transaction,
      });

      if (!pass) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({error: 'Pass not found'});
      }
      const oldPass = pass.dataValues;
      levelId = levelId || pass.levelId;

      // If levelId is changing, fetch the new level data and check for duplicates
      let newLevel = null;
      if (levelId !== pass.levelId) {
        newLevel = await Level.findOne({
          where: {id: levelId},
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
              attributes: ['baseScore'],
            },
            {
              model: LevelCredit,
              as: 'levelCredits',
              include: [{
                model: Creator,
                as: 'creator',
              }],
            },
            {
              model: Team,
              as: 'teamObject',
            },
          ],
          transaction,
        });

        if (!newLevel) {
          await safeTransactionRollback(transaction);
          return res.status(404).json({error: 'New level not found'});
        }
      }

      // Update judgements if provided
      
      if (judgements) {
        const updatedJudgements: IJudgements = sanitizeJudgements(judgements);
        logger.debug('updatedJudgements', updatedJudgements);

        await Judgement.update(
          { ...updatedJudgements },
          {
            where: { id: parseInt(id) },
            transaction,
          },
        );


        const calculatedAccuracy = calcAcc(updatedJudgements);

        // Create pass data for score calculation with proper type handling
        const passData = {
          speed: speed || pass.speed || 1.0,
          judgements: updatedJudgements,
          isNoHoldTap:
            isNoHoldTap !== undefined ? isNoHoldTap : pass.isNoHoldTap || false,
        } as const;

        // Use the new level data if levelId changed, otherwise use existing level data
        const levelData = newLevel || pass.level;

        if (!levelData || !levelData.difficulty) {
          await safeTransactionRollback(transaction);
          return res
            .status(500)
            .json({error: 'Level or difficulty data not found'});
        }

        // Create properly structured level data for score calculation
        const levelDataForScore = {
          baseScore: levelData.baseScore,
          ppBaseScore: levelData.ppBaseScore,
          difficulty: levelData.difficulty,
        };

        const calculatedScore = getScoreV2(passData, levelDataForScore);

        // Update pass with all fields including isDuplicate
        await pass.update(
          {
            levelId: levelId || pass.levelId,
            vidUploadTime: vidUploadTime || pass.vidUploadTime,
            speed: speed || pass.speed,
            feelingRating:
              feelingRating !== undefined ? sanitizeTextInput(feelingRating) : pass.feelingRating,
            vidTitle: vidTitle !== undefined ? sanitizeTextInput(vidTitle) : pass.vidTitle,
            videoLink: videoLink !== undefined ? sanitizeTextInput(videoLink) : pass.videoLink,
            is12K: is12K !== undefined ? is12K : pass.is12K,
            is16K: is16K !== undefined ? is16K : pass.is16K,
            isNoHoldTap:
              isNoHoldTap !== undefined ? isNoHoldTap : pass.isNoHoldTap,
            accuracy: calculatedAccuracy,
            scoreV2: calculatedScore,
            isDeleted: isDeleted !== undefined ? isDeleted : pass.isDeleted,
            playerId: playerId || pass.playerId,
            isAnnounced: isAnnounced !== undefined ? isAnnounced : pass.isAnnounced,
            isDuplicate: isDuplicate !== undefined ? isDuplicate : pass.isDuplicate,
          },
          {transaction},
        );
      } else {
        // Update pass fields without recalculating
        await pass.update(
          {
            levelId: levelId || pass.levelId,
            vidUploadTime: vidUploadTime || pass.vidUploadTime,
            speed: speed || pass.speed,
            feelingRating:
              feelingRating !== undefined ? sanitizeTextInput(feelingRating) : pass.feelingRating,
            vidTitle: vidTitle !== undefined ? sanitizeTextInput(vidTitle) : pass.vidTitle,
            videoLink: videoLink !== undefined ? sanitizeTextInput(videoLink) : pass.videoLink,
            is12K: is12K !== undefined ? is12K : pass.is12K,
            is16K: is16K !== undefined ? is16K : pass.is16K,
            isNoHoldTap:
              isNoHoldTap !== undefined ? isNoHoldTap : pass.isNoHoldTap,
            accuracy: accuracy !== undefined ? accuracy : pass.accuracy,
            scoreV2: scoreV2 !== undefined ? scoreV2 : pass.scoreV2,
            isDeleted: isDeleted !== undefined ? isDeleted : pass.isDeleted,
            playerId: playerId || pass.playerId,
            isAnnounced: isAnnounced !== undefined ? isAnnounced : pass.isAnnounced,
            isDuplicate: isDuplicate !== undefined ? isDuplicate : pass.isDuplicate,
          },
          {transaction},
        );
      }

      // If vidUploadTime changed or levelId changed, recalculate isWorldsFirst for all passes of this level
      if (vidUploadTime || levelId !== oldPass.levelId) {
        // Get the target level ID (either new levelId or current one)

        // Find the earliest non-deleted pass for this level from non-banned players
        const earliestPass = await Pass.findOne({
          where: {
            levelId,
            isDeleted: false
          },
          include: [
            {
            model: Player,
            as: 'player',
            required: true,
            where: {
              isBanned: false
            },
            include: [
              {
                model: User,
                as: 'user',
                required: false,
              }
            ]
            },
          ],
          order: [['vidUploadTime', 'ASC']],
          transaction,
        });

        // Reset all passes for this level to not be world's first
        await Pass.update(
          {isWorldsFirst: false},
          {
            where: {levelId},
            transaction,
          },
        );

        // If we found an earliest pass, mark it as world's first
        if (earliestPass) {
          await Pass.update(
            {isWorldsFirst: true},
            {
              where: {id: earliestPass.id},
              transaction,
            },
          );
        }
        await updateWorldsFirstStatus(oldPass.levelId, transaction);
        await updateWorldsFirstStatus(levelId, transaction);
      }

      // Fetch the updated pass
      const updatedPass = await Pass.findOne({
        where: {id: parseInt(id)},
        include: [
          {
            model: Level,
            as: 'level',
            include: [
              {
                model: Difficulty,
                as: 'difficulty',
              },
              {
                model: LevelCredit,
                as: 'levelCredits',
                include: [{
                  model: Creator,
                  as: 'creator',
                }],
              },
              {
                model: Team,
                as: 'teamObject',
              },
            ],
          },
          {
            model: Judgement,
            as: 'judgements',
          },
          {
            model: Player,
            as: 'player',
            attributes: ['id', 'name', 'country', 'isBanned'],
          },
        ],
        transaction,
      });


      await transaction.commit();

      // Reindex player in Elasticsearch
      if (updatedPass?.player?.id) {
        elasticsearchService.reindexPlayers([updatedPass.player.id]).catch(error => {
          logger.error(`[Passes PUT] Error reindexing player in ES for player ID: ${updatedPass?.player?.id}:`, error);
        });
      }

      if (oldPass.levelId !== updatedPass?.levelId) {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        elasticsearchService.indexLevel(oldPass.levelId);
      }

      // Get player's new stats
      if (updatedPass?.player) {
        try {
          // Emit SSE event with pass update data
          const updateData = {
            playerId: updatedPass.player.id,
            passedLevelId: updatedPass.levelId,
            action: 'update',
          }
          const io = getIO();
          io.emit('passUpdated', updateData);
          sseManager.broadcast({
            type: 'passUpdate',
            data: updateData,
          });

        } catch (error) {
          logger.error('[Passes PUT] Error getting player stats or emitting SSE event:', error);
          // Continue with the response even if this fails
        }
      }


      return res.json(updatedPass);
    } catch (error) {
      logger.error(`[Passes PUT] Error updating pass ID: ${req.params.id}:`, error);
      try {
        await safeTransactionRollback(transaction);

      } catch (rollbackError) {
        logger.error('[Passes PUT] Error rolling back transaction:', rollbackError);
      }
      return res.status(500).json({
        error: 'Failed to update pass',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.delete(
  '/:id([0-9]{1,20})',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'deletePass',
    summary: 'Soft-delete pass',
    description: 'Soft-delete a pass by ID (super admin). Sets isDeleted = true; world\'s first and player stats are updated.',
    tags: ['Passes'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: { 200: { description: 'Deleted pass and message' }, 404: { description: 'Pass not found' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
      let transaction: any;

      try {
        transaction = await sequelize.transaction();
        const id = parseInt(req.params.id);

        const pass = await Pass.findOne({
          where: {id},
          include: [
            {
              model: Level,
              as: 'level',
              include: [
                {
                  model: Difficulty,
                  as: 'difficulty',
                },
                {
                  model: Team,
                  as: 'teamObject',
                },
              ],
            },
            {
              model: Player,
              as: 'player',
              attributes: ['id', 'name', 'country', 'isBanned'],
            },
            {
              model: Judgement,
              as: 'judgements',
            },
          ],
          transaction,
        });

        if (!pass) {
          await safeTransactionRollback(transaction);
          return res.status(404).json({error: 'Pass not found'});
        }

        // Store levelId and playerId before deleting
        const levelId = pass.levelId;
        const playerId = pass.player?.id;

        // Soft delete the pass
        await Pass.update(
          {isDeleted: true},
          {
            where: {id},
            transaction,
          },
        );

        // Update world's first status for this level
        await updateWorldsFirstStatus(levelId, transaction);

        // Reload the pass to get updated data
        await pass.reload({
          include: [
            {
              model: Level,
              as: 'level',
              include: [
                {
                  model: Difficulty,
                  as: 'difficulty',
                },
                {
                  model: LevelCredit,
                  as: 'levelCredits',
                  include: [{
                    model: Creator,
                    as: 'creator',
                  }],
                },
                {
                  model: Team,
                  as: 'teamObject',
                },
              ],
            },
            {
              model: Player,
              as: 'player',
              attributes: ['id', 'name', 'country', 'isBanned'],
            },
            {
              model: Judgement,
              as: 'judgements',
            },
          ],
          transaction,
        });

        await transaction.commit();
        // Reindex player in Elasticsearch
        if (playerId) {
          await elasticsearchService.reindexPlayers([playerId]);
          const playerStats = await playerStatsService.getPlayerStats(playerId).then(stats => stats?.[0]);


          const updateData = {
            playerId,
            passedLevelId: levelId,
            newScore: playerStats?.rankedScore || 0,
            action: 'delete',
          }
          const io = getIO();
          io.emit('passDeleted', updateData);
          sseManager.broadcast({
            type: 'passUpdate',
            data: updateData,
          });
        }
        return res.json({
          message: 'Pass soft deleted successfully',
          pass: pass,
        });
      } catch (error) {
        await safeTransactionRollback(transaction);
        logger.error('Error soft deleting pass:', error);
        return res.status(500).json({error: 'Failed to soft delete pass'});
      }
    },
);

router.patch(
  '/:id([0-9]{1,20})/restore',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'restorePass',
    summary: 'Restore pass',
    description: 'Restore a soft-deleted pass by ID (super admin). Sets isDeleted = false; world\'s first and player stats updated.',
    tags: ['Passes'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: { 200: { description: 'Restored pass and message' }, 404: { description: 'Pass not found' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
      let transaction: any;

      try {
        transaction = await sequelize.transaction();
        const id = parseInt(req.params.id);

        const pass = await Pass.findOne({
          where: {id},
          include: [
            {
              model: Level,
              as: 'level',
              include: [
                {
                  model: Difficulty,
                  as: 'difficulty',
                },
                {
                  model: LevelCredit,
                  as: 'levelCredits',
                  include: [{
                    model: Creator,
                    as: 'creator',
                  }],
                },
                {
                  model: Team,
                  as: 'teamObject',
                },
              ],
            },
            {
              model: Player,
              as: 'player',
              attributes: ['id', 'name', 'country', 'isBanned'],
            },
          ],
          transaction,
        });

        if (!pass) {
          await safeTransactionRollback(transaction);
          return res.status(404).json({error: 'Pass not found'});
        }

        // Store levelId and playerId
        const levelId = pass.levelId;
        const playerId = pass.player?.id;

        // Restore the pass
        await Pass.update(
          {isDeleted: false},
          {
            where: {id},
            transaction,
          },
        );

        // Update world's first status for this level
        await updateWorldsFirstStatus(levelId, transaction);


        await transaction.commit();

        await elasticsearchService.indexLevel(pass.level!);
        // Reindex player in Elasticsearch
        if (playerId) {
          await elasticsearchService.reindexPlayers([playerId]);

          const updateData = {
            playerId,
            passedLevelId: levelId,
            action: 'restore',
          }
          const io = getIO();
          io.emit('passUpdated', updateData);
          sseManager.broadcast({
            type: 'passUpdate',
            data: updateData,
          });
        }

        return res.json({
          message: 'Pass restored successfully',
          pass: pass,
        });
      } catch (error) {
        await safeTransactionRollback(transaction);
        logger.error('Error restoring pass:', error);
        return res.status(500).json({error: 'Failed to restore pass'});
      }
    },
);

router.patch(
  '/:id([0-9]{1,20})/toggle-hidden',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'togglePassHidden',
    summary: 'Toggle pass visibility',
    description: 'Toggle isHidden for a pass. Caller must own the pass (same playerId as authenticated user).',
    tags: ['Passes'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: { 200: { description: 'Updated pass with isHidden toggled' }, 401: { description: 'Authentication required' }, 403: { description: 'Not pass owner' }, 404: { description: 'Pass not found' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
    let transaction: any;
    try {
      transaction = await sequelize.transaction();
      const id = parseInt(req.params.id);
      const user = req.user;

      if (!user || !user.playerId) {
        await safeTransactionRollback(transaction);
        return res.status(401).json({ error: 'Authentication required' });
      }

      // Find the pass
      const pass = await Pass.findOne({
        where: { id },
        include: [
          {
            model: Player,
            as: 'player',
            attributes: ['id'],
          },
        ],
        transaction,
      });

      if (!pass) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({ error: 'Pass not found' });
      }

      // Check if user owns this pass
      if (pass.playerId !== user.playerId) {
        await safeTransactionRollback(transaction);
        return res.status(403).json({ error: 'You can only hide your own passes' });
      }

      // Toggle isHidden
      const newIsHidden = !pass.isHidden;
      await pass.update(
        { isHidden: newIsHidden },
        { transaction }
      );

      await transaction.commit();

      // Reindex the pass in Elasticsearch; also reindex player because visibility affects stats
      await elasticsearchService.indexPass(pass.id);
      if (pass.playerId) {
        await elasticsearchService.reindexPlayers([pass.playerId]);
      }

      return res.json({
        message: `Pass ${newIsHidden ? 'hidden' : 'unhidden'} successfully`,
        pass: {
          ...pass.toJSON(),
          isHidden: newIsHidden,
        },
      });
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error toggling pass hidden status:', error);
      return res.status(500).json({ error: 'Failed to toggle pass hidden status' });
    }
  },
);

export default router;
