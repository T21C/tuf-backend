import { Router, Request, Response } from 'express';
import sequelize from '../../../config/db.js';
import Level from '../../../models/levels/Level.js';
import Difficulty from '../../../models/levels/Difficulty.js';
import { Auth } from "../../../middleware/auth.js";
import { Transaction } from "sequelize";
import Rating from "../../../models/levels/Rating.js";
import Pass from "../../../models/passes/Pass.js";
import Judgement from "../../../models/passes/Judgement.js";
import { calcAcc } from "../../../utils/CalcAcc.js";
import { getScoreV2 } from "../../../utils/CalcScore.js";
import { PlayerStatsService } from "../../../services/PlayerStatsService.js";
import { sseManager } from "../../../utils/sse.js";
import LevelLikes from "../../../models/levels/LevelLikes.js";
import RatingAccuracyVote from "../../../models/levels/RatingAccuracyVote.js";
import User from "../../../models/auth/User.js";
import Player from "../../../models/players/Player.js";
import { logger } from "../../../services/LoggerService.js";
import ElasticsearchService from '../../../services/ElasticsearchService.js';
import { isCdnUrl, getFileIdFromCdnUrl, safeTransactionRollback, sanitizeTextInput } from '../../../utils/Utility.js';
import cdnService from '../../../services/CdnService.js';
import { CDN_CONFIG } from '../../../cdnService/config.js';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { cleanupUserUploads } from '../../misc/chunkedUpload.js';
import LevelRerateHistory from '../../../models/levels/LevelRerateHistory.js';
import { permissionFlags } from '../../../config/constants.js';
import { hasFlag } from '../../../utils/permissionUtils.js';

const playerStatsService = PlayerStatsService.getInstance();
const elasticsearchService = ElasticsearchService.getInstance();

const router = Router();

// Configure multer for handling file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});

// Helper functions for level updates
const handleRatingChanges = async (level: Level, req: Request, transaction: Transaction) => {
  if (typeof req.body.toRate === 'boolean' && req.body.toRate !== level.toRate) {
    if (req.body.toRate) {
      // Create new rating if toRate is being set to true
      const existingRating = await Rating.findOne({
        where: {
          levelId: level.id,
          confirmedAt: null,
        },
        transaction,
      });

      if (!existingRating) {
        const lowDiff = req.body.rerateNum
          ? /^[pP]\d/.test(req.body.rerateNum)
          : false;

        await Rating.create(
          {
            levelId: level.id,
            currentDifficultyId: 0,
            lowDiff,
            requesterFR: '',
            averageDifficultyId: null,
            communityDifficultyId: null,
            confirmedAt: null,
          },
          {transaction},
        );
      }
    } else {
      // Delete rating if toRate is being set to false
      const existingRating = await Rating.findOne({
        where: {
          levelId: level.id,
          confirmedAt: null,
        },
        transaction,
      });

      if (existingRating) {
        await Rating.update({
          confirmedAt: new Date(),
        }, {
          where: {id: existingRating.id},
          transaction,
        });
      }
    }
  }
};

const handleLowDiffFlag = async (level: Level, req: Request, transaction: Transaction) => {
  const existingRating = await Rating.findOne({
    where: {
      levelId: level.id,
      confirmedAt: null,
    },
    transaction,
  });

  if (existingRating) {
    const lowDiff =
      /^[pP]\d/.test(req.body.rerateNum) ||
      /^[pP]\d/.test(existingRating.dataValues.requesterFR);
    await existingRating.update({lowDiff}, {transaction});
  }
};

const handleFlagChanges = (level: Level, req: Request) => {
  let isDeleted = level.isDeleted;
  let isHidden = level.isHidden;
  let isAnnounced = level.isAnnounced;

  if (req.body.isDeleted === true) {
    isDeleted = true;
    isHidden = true;
  } else if (req.body.isDeleted === false) {
    isDeleted = false;
    isHidden = false;
  } else if (req.body.isHidden !== undefined) {
    isHidden = req.body.isHidden;
  }

  if (req.body.isAnnounced !== undefined) {
    isAnnounced = req.body.isAnnounced;
  } else {
    if (req.body.toRate === true && level.toRate === false) {
      isAnnounced = true;
    } else if (req.body.toRate === false && level.toRate === true) {
      const hasChanges = 
        (level.diffId !== (req.body.diffId || level.diffId || 0)) ||
        (level.baseScore !== (req.body.baseScore || level.baseScore || 0));
      
      isAnnounced = !hasChanges;
    }
  }

  return { isDeleted, isHidden, isAnnounced };
};

const handleScoreRecalculations = async (levelId: number, updateData: any, transaction: Transaction) => {
  const passes = await Pass.findAll({
    where: {levelId},
    include: [
      {
        model: Judgement,
        as: 'judgements',
      },
    ],
    transaction,
  });

  const batchSize = 100;
  for (let i = 0; i < passes.length; i += batchSize) {
    const batch = passes.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async passData => {
        const pass = passData.dataValues;
        if (!pass.judgements) return;

        const accuracy = calcAcc(pass.judgements);
        const currentDifficulty = await Difficulty.findByPk(
          updateData.diffId || pass.level?.diffId,
          {
            transaction,
          },
        );

        if (!currentDifficulty) {
          logger.error(`No difficulty found for pass ${pass.id} with diffId ${updateData.diffId || pass.level?.diffId}`);
          return;
        }

        const levelData = {
          baseScore:
            updateData.baseScore || pass.level?.baseScore || 0,
          difficulty: currentDifficulty,
        };

        const scoreV2 = getScoreV2(
          {
            speed: pass.speed || 1,
            judgements: pass.judgements,
            isNoHoldTap: pass.isNoHoldTap || false,
          },
          levelData,
        );

        await Pass.update(
          {accuracy, scoreV2},
          {
            where: {id: pass.id},
            transaction,
          },
        );
      }),
    );
  }

  return passes.map(pass => pass.playerId);
};

// Update a level
router.put('/:id', Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction({
      isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ,
    });
    
    try {
      const levelId = parseInt(req.params.id);
      if (isNaN(levelId)) {
        return res.status(400).json({error: 'Invalid level ID'});
      }
  
      const level = await Level.findOne({
        where: {id: levelId},
        include: [
          {
            model: Difficulty,
            as: 'difficulty',
            required: false,
          },
        ],
        transaction,
        lock: true,
      });
  
      if (!level) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({error: 'Level not found'});
      }

      if (req.body.dlLink && isCdnUrl(level.dlLink) && req.body.dlLink !== level.dlLink) {
        await safeTransactionRollback(transaction);
        return res.status(403).json({
          error: 'Cannot modify CDN-managed download link directly. Use the upload management endpoints instead.'
        });
      }
  
      // Initialize previous state variables
      let baseScore = level.baseScore || 0;
      let previousDiffId = level.previousDiffId || 0;
      let previousBaseScore = level.previousBaseScore || 0;
  
      // Handle rating-related changes
      await handleRatingChanges(level, req, transaction);
      await handleLowDiffFlag(level, req, transaction);
  
      // Handle flag changes
      const { isDeleted, isHidden, isAnnounced } = handleFlagChanges(level, req);
  
      if (req.body.baseScore !== undefined && req.body.baseScore !== null && !isNaN(Number(req.body.baseScore))) {
        baseScore = Number(req.body.baseScore);
        logger.debug(`Setting baseScore to ${baseScore} for level ${levelId}`);
      }

      if (req.body.previousDiffId !== undefined && req.body.previousDiffId !== null && !req.body.toRate) {
        previousDiffId = Number(req.body.previousDiffId);
        logger.debug(`Setting previousDiffId to ${previousDiffId} for level ${levelId}`);
      }
      
      if (req.body.previousBaseScore !== undefined && req.body.previousBaseScore !== null && !req.body.toRate) {
        previousBaseScore = Number(req.body.previousBaseScore);
        logger.debug(`Setting previousBaseScore to ${previousBaseScore} for level ${levelId}`);
      }

      if (req.body.toRate === true && !level.toRate) {
        previousDiffId = level.diffId || 0;
        previousBaseScore = level.baseScore || 0;
        logger.debug(`Freezing state for level ${levelId} - previousDiffId: ${previousDiffId}, previousBaseScore: ${previousBaseScore}`);
      }

      const updateData = {
        song: sanitizeTextInput(req.body.song),
        artist: sanitizeTextInput(req.body.artist),
        creator: sanitizeTextInput(req.body.creator),
        charter: sanitizeTextInput(req.body.charter),
        vfxer: sanitizeTextInput(req.body.vfxer),
        team: sanitizeTextInput(req.body.team),
        diffId: Number(req.body.diffId) || 0,
        previousDiffId,
        baseScore,
        previousBaseScore,
        videoLink: sanitizeTextInput(req.body.videoLink),
        dlLink: sanitizeTextInput(req.body.dlLink),
        workshopLink: sanitizeTextInput(req.body.workshopLink),
        publicComments: sanitizeTextInput(req.body.publicComments),
        rerateNum: sanitizeTextInput(req.body.rerateNum),
        toRate: req.body.toRate ?? level.toRate,
        rerateReason: sanitizeTextInput(req.body.rerateReason),
        isDeleted,
        isHidden,
        isAnnounced,
        isExternallyAvailable: req.body.isExternallyAvailable ?? level.isExternallyAvailable,
        updatedAt: new Date(),
      };
  
      await Level.update(updateData, {
        where: {id: levelId},
        transaction,
      });
  
      // Fetch the updated level again to get the latest state
      const updatedLevel = await Level.findOne({
        where: {id: levelId},
        include: [
          {
            model: Difficulty,
            as: 'difficulty',
            required: false,
          },
        ],
        transaction,
      });

      // Insert rerate history if rerate is settled (isAnnounced goes from false to true and diffId/baseScore changes)
      if (
        (
          level.diffId !== (req.body.diffId ?? level.diffId)
          ||
          level.baseScore !== (req.body.baseScore ?? level.baseScore)
        )
        && level.diffId !== 0 && req.body.diffId !== 0
      ) {
        logger.debug(`Inserting rerate history for level ${levelId} - previousDiffId: ${level.diffId}, newDiffId: ${req.body.diffId ?? level.diffId}`);
        await LevelRerateHistory.create({
          levelId: level.id,
          previousDiffId: level.diffId,
          newDiffId: req.body.diffId ?? level.diffId,
          previousBaseScore: level.baseScore || 0,
          newBaseScore: req.body.baseScore ?? (level.baseScore || 0),
          reratedBy: req.user?.id ?? null,
          createdAt: new Date(),
        }, { transaction });
      }
      const rerateHistory = await LevelRerateHistory.findAll({
        where: { levelId: levelId },
        order: [['createdAt', 'DESC']],
        transaction,
      });
      logger.debug(`Rerate history: ${JSON.stringify(rerateHistory)}`);
      await transaction.commit();


      const response = {
        message: 'Level updated successfully',
        level: updatedLevel,
        rerateHistory,
      };
      res.json(response);
  
      // Handle async operations
      (async () => {
        let recalcTransaction: Transaction | null = null;
        try {
          recalcTransaction = await sequelize.transaction({
            isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED,
          });
  
          if (req.body.baseScore !== undefined || req.body.diffId !== undefined) {
            const affectedPlayerIds = await handleScoreRecalculations(levelId, updateData, recalcTransaction);
            playerStatsService.updatePlayerStats(Array.from(new Set(affectedPlayerIds)));
          }
  
          await recalcTransaction.commit();
  
          sseManager.broadcast({type: 'ratingUpdate'});
          sseManager.broadcast({type: 'levelUpdate'});
          sseManager.broadcast({
            type: 'passUpdate',
            data: {
              levelId,
              action: 'levelUpdate',
            },
          });
        } catch (error) {
          if (recalcTransaction) {
            try {
              await recalcTransaction.rollback();
            } catch (rollbackError) {
              // Ignore rollback errors - transaction might already be rolled back
              logger.warn('Transaction rollback failed:', rollbackError);
            }
          }
          logger.error('Error in async operations after level update:', error);
        }
      })()
        .then(() => {
          return;
        })
        .catch(error => {
          logger.error('Error in async operations after level update:', error);
          return;
        });

      if (updatedLevel) {
        await elasticsearchService.indexLevel(updatedLevel);
      }
      
      return;
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error updating level:', error);
      return res.status(500).json({error: 'Failed to update level'});
    }
  });
  
  // Toggle rating status for a level
  router.put('/:id/toRate', Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
  
    try {
      const levelId = parseInt(req.params.id);
      if (isNaN(levelId)) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({error: 'Invalid level ID'});
      }
  
      // Get the level
      const level = await Level.findByPk(levelId, {transaction});
      if (!level) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({error: 'Level not found'});
      }
  
      // Check if rating exists
      const existingRating = await Rating.findOne({
        where: {
          levelId,
          confirmedAt: null,
        },
        transaction,
      });
  
      if (existingRating) {
        // If rating exists, mark it as confirmed
        await Rating.update({
          confirmedAt: new Date(),
        }, {
          where: {id: existingRating.id},
          transaction,
        });
  
        // Update level with consistent announcement flag handling
        await Level.update(
          {
            toRate: false,
            isAnnounced: false, // Reset announcement flag when removing from rating
          },
          {
            where: {id: levelId},
            transaction,
          },
        );
  
        await transaction.commit();
  
        // Broadcast updates
        sseManager.broadcast({type: 'ratingUpdate'});
        sseManager.broadcast({type: 'levelUpdate'});
  
        return res.json({
          message: 'Rating removed successfully',
          toRate: false,
        });
      } else {
        // Create new rating with default values
        const newRating = await Rating.create(
          {
            levelId,
            currentDifficultyId: 0,
            lowDiff: false,
            requesterFR: '',
            averageDifficultyId: null,
          },
          {transaction},
        );
  
        // Update level to mark for rating with consistent announcement flag handling
        await Level.update(
          {
            toRate: true,
            isAnnounced: true, // Set announcement flag when adding to rating
          },
          {
            where: {id: levelId},
            transaction,
          },
        );
  
        await transaction.commit();
  
        // Broadcast updates
        sseManager.broadcast({type: 'ratingUpdate'});
        sseManager.broadcast({type: 'levelUpdate'});
  
        return res.json({
          message: 'Rating created successfully',
          toRate: true,
          ratingId: newRating.id,
        });
      }
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error toggling rating status:', error);
      return res.status(500).json({
        error: 'Failed to toggle rating status',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });
  
  router.delete('/:id', Auth.superAdmin(), async (req: Request, res: Response) => {
      const transaction = await sequelize.transaction();
      try {
        const levelId = parseInt(req.params.id);
        if (isNaN(levelId)) {
          return res.status(400).json({error: 'Invalid level ID'});
        }
  
        const level = await Level.findOne({
          where: {id: levelId.toString()},
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
              required: false,
            },
            {
              model: Pass,
              as: 'passes',
              required: false,
              attributes: ['id'],
            },
          ],
          transaction,
        });
  
        if (!level) {
          return res.status(404).json({error: 'Level not found'});
        }
  
        await Level.update(
          {isDeleted: true},
          {
            where: {id: levelId.toString()},
            transaction,
          },
        );
  
        await transaction.commit();
  
        // Send response immediately after commit
        const response = {
          message: 'Level soft deleted successfully',
          level: level,
        };
        res.json(response);
  
        // Handle cache updates and broadcasts asynchronously
        (async () => {
          try {
            // Get affected players before deletion
            const affectedPasses = await Pass.findAll({
              where: {levelId},
              attributes: ['playerId'],
            });
  
            const affectedPlayerIds = new Set(
              affectedPasses.map(pass => pass.playerId),
            );
  
            // Schedule stats update for affected players
            playerStatsService.updatePlayerStats(Array.from(affectedPlayerIds));
  
  
            // Broadcast updates
            sseManager.broadcast({type: 'levelUpdate'});
            sseManager.broadcast({type: 'ratingUpdate'});
          } catch (error) {
            logger.error(
              'Error in async operations after level deletion:',
              error,
            );
          }
        })()
          .then(() => {
            return;
          })
          .catch(error => {
            logger.error(
              'Error in async operations after level deletion:',
              error,
            );
            return;
          });

        return res.status(204).end();
      } catch (error) {
        await safeTransactionRollback(transaction);
        logger.error('Error soft deleting level:', error);
        return res.status(500).json({error: 'Failed to soft delete level'});
      }
    },
  );
  
  router.patch('/:id/restore', Auth.superAdmin(), async (req: Request, res: Response) => {
      const transaction = await sequelize.transaction();
  
      try {
        const {id} = req.params;
  
        const level = await Level.findOne({
          where: {id: parseInt(id)},
          transaction,
        });
  
        if (!level) {
          await safeTransactionRollback(transaction);
          return res.status(404).json({error: 'Level not found'});
        }
  
        // Restore both isDeleted and isHidden flags
        await Level.update(
          {
            isDeleted: false,
            isHidden: false,
          },
          {
            where: {id: parseInt(id)},
            transaction,
          },
        );
  
        // Reload the level to get updated data
        await level.reload({
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
            },
            {
              model: Pass,
              as: 'passes',
              required: false,
              attributes: ['id'],
            },
          ],
          transaction,
        });
  
        await transaction.commit();
  
        // Broadcast updates
        sseManager.broadcast({type: 'levelUpdate'});
        sseManager.broadcast({type: 'ratingUpdate'});
  
        // Reload stats for new level
        await playerStatsService.reloadAllStats();
  
        return res.json({
          message: 'Level restored successfully',
          level: level,
        });
      } catch (error) {
        await safeTransactionRollback(transaction);
        logger.error('Error restoring level:', error);
        return res.status(500).json({error: 'Failed to restore level'});
      }
    },
  );

  
// Toggle hidden status
router.patch('/:id/toggle-hidden', Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();

    try {
      const {id} = req.params;

      const level = await Level.findOne({
        where: {id: parseInt(id)},
        transaction,
      });

      if (!level) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({error: 'Level not found'});
      }

      // Toggle the hidden status
      await Level.update(
        {isHidden: !level.isHidden},
        {
          where: {id: parseInt(id)},
          transaction,
        },
      );

      await transaction.commit();


      // Broadcast updates
      sseManager.broadcast({type: 'levelUpdate'});

      return res.json({
        message: `Level ${level.isHidden ? 'unhidden' : 'hidden'} successfully`,
        isHidden: !level.isHidden,
      });
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error toggling level hidden status:', error);
      return res.status(500).json({
        error: 'Failed to toggle level hidden status',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.put('/:id/like', Auth.verified(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    if (!req.user) {
      await safeTransactionRollback(transaction);
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const levelId = parseInt(req.params.id);
      const { action } = req.body;
  
      if (isNaN(levelId) || !Number.isInteger(levelId) || levelId <= 0) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Invalid level ID' });
      }
  
      if (!action || !['like', 'unlike'].includes(action)) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Invalid action. Must be "like" or "unlike"' });
      }
  
      // Check if level exists
      const level = await Level.findByPk(levelId, { transaction });
      if (!level) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({ error: 'Level not found' });
      }
  
      // Check if level is deleted
      if (level.isDeleted) {
        await safeTransactionRollback(transaction);
        return res.status(403).json({ error: 'Cannot like deleted level' });
      }
      if (action === 'like') {
        // Use findOrCreate to handle race conditions atomically
        const [like, created] = await LevelLikes.findOrCreate({
          where: { levelId, userId: req.user?.id },
          transaction,
        });

        if (!created) {
          await safeTransactionRollback(transaction);
          return res.status(400).json({ error: 'You have already liked this level' });
        }
      } else {
        // Check if user already liked the level
        const existingLike = await LevelLikes.findOne({
          where: { levelId, userId: req.user?.id },
          transaction,
        });

        if (!existingLike) {
          await safeTransactionRollback(transaction);
          return res.status(400).json({ error: 'You have not liked this level' });
        }

        // Remove like
        await LevelLikes.destroy({
          where: { levelId, userId: req.user?.id },
          transaction,
        });
      }
  
      await transaction.commit();
  
      // Get updated like count
      const likeCount = await LevelLikes.count({
        where: { levelId },
      });
  
      return res.json({
        success: true,
        action,
        likes: likeCount
      });
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error toggling level like:', error);
      return res.status(500).json({ error: 'Failed to toggle level like' });
    }
  });

router.put('/:id/rating-accuracy-vote', Auth.verified(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const { id } = req.params;
    const { vote } = req.body;

    if (!req.user) {
      await safeTransactionRollback(transaction);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (vote === undefined || isNaN(vote) || !Number.isInteger(vote)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Invalid vote value' });
    }

    if (-5 > vote || vote > 5) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'Vote must be between -5 and 5' });
    }

    const level = await Level.findByPk(id, {
      include: [
        {
          model: Difficulty,
          as: 'difficulty',
        },
      ],
      transaction,
    });
    if (!level) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({ error: 'Level not found' });
    }
    if (level.difficulty?.type !== "PGU") {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'You cannot vote on a non-PGU level' });
    }
    const isPassed = await Pass.findOne({
      where: {
        levelId: id,
        playerId: req.user?.playerId,
      },
      transaction,
    });

    if (!isPassed) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'You must pass the level to vote on its rating accuracy' });
    }

    const existingVote = await RatingAccuracyVote.findOne({
      where: {
        levelId: parseInt(id),
        diffId: level.diffId,
        userId: req.user?.id,
      },
      transaction,
    });

    if (existingVote) {
      await RatingAccuracyVote.update({
        vote,
      }, 
      {
        where: { id: existingVote.id },
        transaction,
      });
    } else {
      await RatingAccuracyVote.create({
        levelId: parseInt(id),
        diffId: level.diffId,
        userId: req.user?.id,
        vote,
      },
      {
        transaction,
      });
    }

    await level.reload()

    await transaction.commit();
    
    const votes = await RatingAccuracyVote.findAll({
      where: { 
        levelId: parseInt(id), 
        diffId: level.diffId
      },
      include: [
        {
          model: User,
          as: 'user',
          attributes: ['username'],
          include: [
            {
              model: Player,
              as: 'player',
              attributes: ['name'],
            },
          ],
        },
      ],
    });
    
    return res.status(200).json({ 
        message: 'Rating accuracy vote submitted successfully',
        level, 
        totalVotes: votes.length, 
        votes: req.user && hasFlag(req.user, permissionFlags.SUPER_ADMIN) ? votes : undefined });
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error voting on rating accuracy:', error);
    return res.status(500).json({ error: 'Failed to vote on rating accuracy' });
  }
})

// Upload management endpoints
router.post('/:id/upload', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const { fileId, fileName, fileSize } = req.body;
    const levelId = parseInt(req.params.id);

    if (isNaN(levelId)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({error: 'Invalid level ID'});
    }

    if (!fileId || !fileName || !fileSize) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({error: 'Missing required file information'});
    }

    const level = await Level.findByPk(levelId, { transaction });
    if (!level) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({error: 'Level not found'});
    }

    try {
      // Store the old file ID for cleanup if it exists
      let oldFileId: string | null = null;
      if (level.dlLink && isCdnUrl(level.dlLink)) {
        oldFileId = getFileIdFromCdnUrl(level.dlLink);
        logger.info('Found existing CDN file to clean up after upload', {
          levelId,
          oldFileId,
          oldDlLink: level.dlLink
        });
      }

      // Read the assembled file
      const assembledFilePath = path.join('uploads', 'assembled', req.user!.id, `${fileId}.zip`);
      const fileBuffer = await fs.promises.readFile(assembledFilePath);
      
      const uploadResult = await cdnService.uploadLevelZip(
        fileBuffer, 
        fileName
      );

      // Clean up the assembled file
      await fs.promises.unlink(assembledFilePath);

      // Get the level files from the CDN service
      const levelFiles = await cdnService.getLevelFiles(uploadResult.fileId);
      
      // Update level with new download link
      level.dlLink = `${CDN_CONFIG.baseUrl}/${uploadResult.fileId}`;
      await level.save({ transaction });

      // Commit the transaction
      await transaction.commit();

      // Clean up old CDN file after successful upload and database update
      if (oldFileId) {
        try {
          logger.info('Cleaning up old CDN file after successful upload', {
            levelId,
            oldFileId,
            newFileId: uploadResult.fileId
          });
          await cdnService.deleteFile(oldFileId);
          logger.info('Successfully cleaned up old CDN file', {
            levelId,
            oldFileId
          });
        } catch (cleanupError) {
          // Log cleanup error but don't fail the request since the upload was successful
          logger.error('Failed to clean up old CDN file after successful upload:', {
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            levelId,
            oldFileId,
            newFileId: uploadResult.fileId
          });
        }
      }

      // Clean up all user uploads after successful processing
      try {
        await cleanupUserUploads(req.user!.id);
      } catch (cleanupError) {
        // Log cleanup error but don't fail the request
        logger.warn('Failed to clean up user uploads after successful processing:', cleanupError);
      }

      return res.json({
        success: true,
        level: {
          ...level,
          dlLink: level.dlLink
        },
        levelFiles
      });

    } catch (error) {
      // Clean up the assembled file in case of error
      try {
        const assembledFilePath = path.join('uploads', 'assembled', req.user!.id, `${fileId}.zip`);
        await fs.promises.unlink(assembledFilePath);
      } catch (cleanupError) {
        logger.warn('Failed to clean up assembled file:', cleanupError);
      }
      throw error;
    }
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error uploading level file:', error);
    return res.status(500).json({
      error: 'Failed to upload level file',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

router.post('/:id/select-level', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const { selectedLevel } = req.body;
    const levelId = parseInt(req.params.id);
    if (isNaN(levelId) || !selectedLevel) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({error: 'Invalid level ID or missing selected level'});
    }

    const level = await Level.findByPk(levelId, { transaction }); 
    if (!level) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({error: 'Level not found'});
    }

    const fileId = getFileIdFromCdnUrl(level.dlLink);
    if (!fileId) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({error: 'File ID is required'});
    }

    const file = await cdnService.setTargetLevel(fileId, selectedLevel);
    if (!file) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({error: 'File not found'});
    }

    await transaction.commit();

    return res.json({
      success: true,
      message: 'Level file selected successfully'
    });
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error selecting level file:', error);
    return res.status(500).json({
      error: 'Failed to select level file',
      details: error instanceof Error ? error.message : String(error)
    });
  }
})

router.delete('/:id/upload', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  
  try {
    const levelId = parseInt(req.params.id);
    if (isNaN(levelId)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({error: 'Invalid level ID'});
    }

    // Get current level
    const level = await Level.findByPk(levelId, { transaction });
    if (!level) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({error: 'Level not found'});
    }

    // Check if level has a CDN-managed file
    if (!level.dlLink || !isCdnUrl(level.dlLink)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({error: 'Level does not have a CDN-managed file'});
    }

    // Delete file from CDN
    const fileId = getFileIdFromCdnUrl(level.dlLink)!;
    logger.debug(`Deleting file from CDN: ${fileId}`);
    await cdnService.deleteFile(fileId);

    // Update level to remove download link
    await Level.update({
      dlLink: 'removed'
    }, {
      where: { id: levelId },
      transaction
    });

    await transaction.commit();

    return res.json({
      success: true,
      dlLink: 'removed',
      message: 'Level file deleted successfully'
    });
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error deleting level file:', error);
    return res.status(500).json({
      error: 'Failed to delete level file',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

export default router;
