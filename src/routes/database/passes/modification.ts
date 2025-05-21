import { Router, Request, Response } from 'express';
import { Auth } from '../../../middleware/auth.js';
import Pass from '../../../models/passes/Pass.js';
import Player from '../../../models/players/Player.js';
import Level from '../../../models/levels/Level.js';
import Judgement from '../../../models/passes/Judgement.js';
import Difficulty from '../../../models/levels/Difficulty.js';
import { logger } from '../../../services/LoggerService.js';
import sequelize from '../../../config/db.js';
import { sanitizeTextInput, updateWorldsFirstStatus } from './index.js';
import { calcAcc, IJudgements } from '../../../utils/CalcAcc.js';
import { getScoreV2 } from '../../../utils/CalcScore.js';
import { PlayerStatsService } from '../../../services/PlayerStatsService.js';
import { getIO } from '../../../utils/socket.js';
import { sseManager } from '../../../utils/sse.js';
import ElasticsearchService from '../../../services/ElasticsearchService.js';

const playerStatsService = PlayerStatsService.getInstance();
const elasticsearchService = ElasticsearchService.getInstance();
const router = Router();

router.put('/:id([0-9]+)', Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    try {
      const {id} = req.params;
      const {
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
  
  
      logger.debug(`[Passes PUT] Request body:`, {
        levelId,
        vidUploadTime,
        speed,
        feelingRating: sanitizeTextInput(feelingRating),
        vidTitle: sanitizeTextInput(vidTitle),
        videoLink: sanitizeTextInput(videoLink),
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
      });
  
      // First fetch the pass with its current level data
      logger.debug(`[Passes PUT] Fetching pass with ID: ${id}`);
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
        logger.debug(`[Passes PUT] Pass not found with ID: ${id}`);
        await transaction.rollback();
        return res.status(404).json({error: 'Pass not found'});
      }
  
      logger.debug(`[Passes PUT] Found pass with ID: ${id}, player ID: ${pass.player?.id}`);
  
      // If levelId is changing, fetch the new level data and check for duplicates
      let newLevel = null;
      if (levelId && levelId !== pass.levelId) {
        logger.debug(`[Passes PUT] Level ID changing from ${pass.levelId} to ${levelId}`);
        newLevel = await Level.findOne({
          where: {id: levelId},
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
              attributes: ['baseScore'],
            },
          ],
          transaction,
        });
  
        if (!newLevel) {
          logger.debug(`[Passes PUT] New level not found with ID: ${levelId}`);
          await transaction.rollback();
          return res.status(404).json({error: 'New level not found'});
        }
      }
  
      // Update judgements if provided
      if (judgements) {
        logger.debug(`[Passes PUT] Updating judgements for pass ID: ${id}`);
        await Judgement.update(
          {
            earlyDouble: judgements.earlyDouble,
            earlySingle: judgements.earlySingle,
            ePerfect: judgements.ePerfect,
            perfect: judgements.perfect,
            lPerfect: judgements.lPerfect,
            lateSingle: judgements.lateSingle,
            lateDouble: judgements.lateDouble,
          },
          {
            where: {id: parseInt(id)},
            transaction,
          },
        );
  
        // Recalculate accuracy and score
        const updatedJudgements: IJudgements = {
          earlyDouble: judgements.earlyDouble,
          earlySingle: judgements.earlySingle,
          ePerfect: judgements.ePerfect,
          perfect: judgements.perfect,
          lPerfect: judgements.lPerfect,
          lateSingle: judgements.lateSingle,
          lateDouble: judgements.lateDouble,
        };
  
        const calculatedAccuracy = calcAcc(updatedJudgements);
        logger.debug(`[Passes PUT] Calculated accuracy: ${calculatedAccuracy}`);
  
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
          logger.debug(`[Passes PUT] Level or difficulty data not found for pass ID: ${id}`);
          await transaction.rollback();
          return res
            .status(500)
            .json({error: 'Level or difficulty data not found'});
        }
  
        // Create properly structured level data for score calculation
        const levelDataForScore = {
          baseScore: levelData.baseScore,
          difficulty: levelData.difficulty,
        };
  
        const calculatedScore = getScoreV2(passData, levelDataForScore);
        logger.debug(`[Passes PUT] Calculated score: ${calculatedScore}`);
  
        // Update pass with all fields including isDuplicate
        logger.debug(`[Passes PUT] Updating pass with calculated values`);
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
        logger.debug(`[Passes PUT] Updating pass without recalculating judgements`);
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
      if (vidUploadTime || levelId) {
        // Get the target level ID (either new levelId or current one)
        const targetLevelId = levelId || pass.levelId;
        logger.debug(`[Passes PUT] Recalculating world's first for level ID: ${targetLevelId}`);
        
        // Find the earliest non-deleted pass for this level from non-banned players
        const earliestPass = await Pass.findOne({
          where: {
            levelId: targetLevelId,
            isDeleted: false
          },
          include: [
            {
              model: Player,
              as: 'player',
              where: {isBanned: false},
              required: true,
            },
          ],
          order: [['vidUploadTime', 'ASC']],
          transaction,
        });
  
        // Reset all passes for this level to not be world's first
        logger.debug(`[Passes PUT] Resetting world's first status for all passes of level ID: ${targetLevelId}`);
        await Pass.update(
          {isWorldsFirst: false},
          {
            where: {levelId: targetLevelId},
            transaction,
          },
        );
  
        // If we found an earliest pass, mark it as world's first
        if (earliestPass) {
          logger.debug(`[Passes PUT] Setting world's first for pass ID: ${earliestPass.id}`);
          await Pass.update(
            {isWorldsFirst: true},
            {
              where: {id: earliestPass.id},
              transaction,
            },
          );
        }
  
        // If levelId changed, also update world's first for the old level
        if (levelId && levelId !== pass.levelId) {
          logger.debug(`[Passes PUT] Level ID changed, updating world's first for old level ID: ${pass.levelId}`);
          await updateWorldsFirstStatus(pass.levelId, transaction);
          await updateWorldsFirstStatus(levelId, transaction);
        }
      }
  
      // Fetch the updated pass
      logger.debug(`[Passes PUT] Fetching updated pass data`);
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
  
      logger.debug(`[Passes PUT] Committing transaction`);
      await transaction.commit();
  
      // Update player stats
      if (pass.player) {
        logger.debug(`[Passes PUT] Updating player stats for player ID: ${pass.player.id}`);
        try {
          await playerStatsService.updatePlayerStats([pass.player.id]);
          logger.debug(`[Passes PUT] Successfully updated player stats for player ID: ${pass.player.id}`);
        } catch (error) {
          logger.error(`[Passes PUT] Error updating player stats for player ID: ${pass.player.id}:`, error);
          // Continue with the response even if player stats update fails
        }
      }
  
      // Reindex affected levels to update clears counter
      try {
        // If levelId changed, reindex both old and new levels
        if (levelId && levelId !== pass.levelId) {
          logger.debug(`[Passes PUT] Reindexing both old level ID: ${pass.levelId} and new level ID: ${levelId}`);
          await Promise.all([
            elasticsearchService.indexLevel(pass.levelId),
            elasticsearchService.indexLevel(levelId)
          ]);
        } else {
          // Otherwise just reindex the current level
          logger.debug(`[Passes PUT] Reindexing level ID: ${pass.levelId}`);
          await elasticsearchService.indexLevel(pass.levelId);
        }
      } catch (error) {
        logger.error(`[Passes PUT] Error reindexing levels after pass update:`, error);
        // Continue with the response even if reindexing fails
      }
  
      const io = getIO();
      io.emit('leaderboardUpdated');
  
      // Get player's new stats
      if (updatedPass && updatedPass.player) {
        logger.debug(`[Passes PUT] Getting updated player stats for player ID: ${updatedPass.player.id}`);
        try {
          const playerStats = await playerStatsService.getPlayerStats(
            updatedPass.player.id,
          );
  
          // Emit SSE event with pass update data
          sseManager.broadcast({
            type: 'passUpdate',
            data: {
              playerId: updatedPass.player.id,
              passedLevelId: updatedPass.levelId,
              newScore: playerStats?.rankedScore || 0,
              action: 'update',
            },
          });
          logger.debug(`[Passes PUT] Successfully emitted SSE event for player ID: ${updatedPass.player.id}`);
        } catch (error) {
          logger.error(`[Passes PUT] Error getting player stats or emitting SSE event:`, error);
          // Continue with the response even if this fails
        }
      }
  
      logger.debug(`[Passes PUT] Successfully completed update for pass ID: ${id}`);
      return res.json(updatedPass);
    } catch (error) {
      logger.error(`[Passes PUT] Error updating pass ID: ${req.params.id}:`, error);
      try {
        await transaction.rollback();
        logger.debug(`[Passes PUT] Successfully rolled back transaction for pass ID: ${req.params.id}`);
      } catch (rollbackError) {
        logger.error(`[Passes PUT] Error rolling back transaction:`, rollbackError);
      }
      return res.status(500).json({
        error: 'Failed to update pass',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });
  
  router.delete('/:id([0-9]+)', Auth.superAdmin(), async (req: Request, res: Response) => {
      const transaction = await sequelize.transaction();
  
      try {
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
          await transaction.rollback();
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
  
        await elasticsearchService.indexLevel(pass.level!);
        // Update player stats
        if (playerId) {
          await playerStatsService.updatePlayerStats([playerId]);
          const playerStats = await playerStatsService.getPlayerStats(playerId);
  
          sseManager.broadcast({
            type: 'passUpdate',
            data: {
              playerId,
              passedLevelId: levelId,
              newScore: playerStats?.rankedScore || 0,
              action: 'delete',
            },
          });
        }
        return res.json({
          message: 'Pass soft deleted successfully',
          pass: pass,
        });
      } catch (error) {
        await transaction.rollback();
        logger.error('Error soft deleting pass:', error);
        return res.status(500).json({error: 'Failed to soft delete pass'});
      }
    },
  );
  
  router.patch('/:id([0-9]+)/restore', Auth.superAdmin(), async (req: Request, res: Response) => {
      const transaction = await sequelize.transaction();
  
      try {
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
          await transaction.rollback();
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
        // Update player stats
        if (playerId) {
          await playerStatsService.updatePlayerStats([playerId]);

          const playerStats = await playerStatsService.getPlayerStats(playerId);
  
          sseManager.broadcast({
            type: 'passUpdate',
            data: {
              playerId,
              passedLevelId: levelId,
              newScore: playerStats?.rankedScore || 0,
              action: 'restore',
            },
          });
        }
  
        return res.json({
          message: 'Pass restored successfully',
          pass: pass,
        });
      } catch (error) {
        await transaction.rollback();
        logger.error('Error restoring pass:', error);
        return res.status(500).json({error: 'Failed to restore pass'});
      }
    },
  );

  export default router;
