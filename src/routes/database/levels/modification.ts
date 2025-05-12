import { handleLevelUpdate, sanitizeTextInput } from "./index.js";
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

const playerStatsService = PlayerStatsService.getInstance();


const router = Router();

// Update a level
router.put('/:id', Auth.superAdmin(), async (req: Request, res: Response) => {
    // Start a transaction with REPEATABLE READ to ensure consistency during the update
    const transaction = await sequelize.transaction({
      isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ,
    });
    
    try {
      const levelId = parseInt(req.params.id);
      if (isNaN(levelId)) {
        return res.status(400).json({error: 'Invalid level ID'});
      }
  
      // First get the current level data
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
        lock: true, // Lock this row for update
      });
  
      if (!level) {
        await transaction.rollback();
        return res.status(404).json({error: 'Level not found'});
      }
  
      // Initialize previous state variables
      let previousDiffId = level.previousDiffId || 0;
      let previousBaseScore = level.previousBaseScore || 0;
  
      // Handle rating creation/deletion if toRate is changing
      if (
        typeof req.body.toRate === 'boolean' &&
        req.body.toRate !== level.toRate
      ) {
        if (req.body.toRate) {
          // Freeze current state when sending to rating
          previousDiffId = level.diffId || 0;
          previousBaseScore = level.baseScore || 0;

          // Create new rating if toRate is being set to true
          const existingRating = await Rating.findOne({
            where: {
              levelId,
              confirmedAt: null,
            },
            transaction,
          });
  
          if (!existingRating) {
            // Check if rerateNum starts with 'p' or 'P' followed by a number
            const lowDiff = req.body.rerateNum
              ? /^[pP]\d/.test(req.body.rerateNum)
              : false;
  
            await Rating.create(
              {
                levelId,
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
              levelId,
              confirmedAt: null,
            },
            transaction,
          });
  
          if (existingRating) {
            // Delete rating details first
            await Rating.update({
              confirmedAt: new Date(),
            }, {
              where: {id: existingRating.id},
              transaction,
            });
          }
        }
      }
  
      // Update lowDiff flag if there's an existing rating
      const existingRating = await Rating.findOne({
        where: {
          levelId,
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
  
      // Handle flag changes
      let isDeleted = level.isDeleted;
      let isHidden = level.isHidden;
      let isAnnounced = level.isAnnounced;
  
      // If isDeleted is being set to true, also set isHidden to true
      if (req.body.isDeleted === true) {
        isDeleted = true;
        isHidden = true;
      }
      // If isDeleted is being set to false, also set isHidden to false
      else if (req.body.isDeleted === false) {
        isDeleted = false;
        isHidden = false;
      }
      // If only isHidden is being changed, respect that change
      else if (req.body.isHidden !== undefined) {
        isHidden = req.body.isHidden;
      }

      // Handle isAnnounced logic
      if (req.body.isAnnounced !== undefined) {
        isAnnounced = req.body.isAnnounced;
      } 
      else {
        // Set isAnnounced to true if toRate is being set to true
        if (req.body.toRate === true) {
          isAnnounced = true;
        }
        else if (req.body.toRate === false && level.toRate === true) {
          const hasChanges = 
            (level.previousDiffId !== req.body.diffId || level.diffId || 0) ||
            (level.previousBaseScore !== req.body.baseScore || level.baseScore || 0);
          
          isAnnounced = !hasChanges;
        }
      }
  
      // Only update previousDiffId and previousBaseScore if they're explicitly provided
      // or if we're not sending to rating (in which case we want to keep the frozen state)
      if (req.body.previousDiffId !== undefined && req.body.previousDiffId !== null && !req.body.toRate) {
        previousDiffId = req.body.previousDiffId;
        logger.info(`Setting previousDiffId to ${previousDiffId} for level ${levelId}`);
      }
      
      if (req.body.previousBaseScore !== undefined && req.body.previousBaseScore !== null && !req.body.toRate) {
        previousBaseScore = req.body.previousBaseScore;
        logger.info(`Setting previousBaseScore to ${previousBaseScore} for level ${levelId}`);
      }

      // Log when freezing state for rating
      if (req.body.toRate === true && !level.toRate) {
        logger.info(`Freezing state for level ${levelId} - previousDiffId: ${previousDiffId}, previousBaseScore: ${previousBaseScore}`);
      }

      // Clean up the update data to handle null values correctly
      const updateData = {
        song: sanitizeTextInput(req.body.song),
        artist: sanitizeTextInput(req.body.artist),
        creator: sanitizeTextInput(req.body.creator),
        charter: sanitizeTextInput(req.body.charter),
        vfxer: sanitizeTextInput(req.body.vfxer),
        team: sanitizeTextInput(req.body.team),
        diffId: req.body.diffId || 0,
        previousDiffId,
        baseScore:
          req.body.baseScore === ''
            ? null
            : (req.body.baseScore ?? level.baseScore),
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
        updatedAt: new Date(),
      };
  
      // Update the level
      await Level.update(updateData, {
        where: {id: levelId},
        transaction,
      });
  
      // Fetch the updated record with minimal associations for the response
      const updatedLevel = await Level.findOne({
        where: {id: levelId},
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

      
      await transaction.commit();
      // Send response immediately after commit
      const response = {
        message: 'Level updated successfully',
        level: updatedLevel,
      };
      res.json(response);
  
      // Handle cache updates and score recalculations asynchronously
      (async () => {
        try {
          // Start a new transaction for score recalculations
          const recalcTransaction = await sequelize.transaction({
            isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED,
          });
  
          try {
            // If baseScore or diffId changed, recalculate all passes for this level
            if (
              req.body.baseScore !== undefined ||
              req.body.diffId !== undefined
            ) {
              const passes = await Pass.findAll({
                where: {levelId},
                include: [
                  {
                    model: Judgement,
                    as: 'judgements',
                  },
                ],
                transaction: recalcTransaction,
              });
  
              // Process passes in batches to avoid memory issues
              const batchSize = 100;
              for (let i = 0; i < passes.length; i += batchSize) {
                const batch = passes.slice(i, i + batchSize);
                await Promise.all(
                  batch.map(async passData => {
                    const pass = passData.dataValues;
                    if (!pass.judgements) return;
  
                    const accuracy = calcAcc(pass.judgements);
  
                    // Get the current difficulty data
                    const currentDifficulty = await Difficulty.findByPk(
                      updateData.diffId || pass.level?.diffId,
                      {
                        transaction: recalcTransaction,
                      },
                    );
  
                    if (!currentDifficulty) {
                      logger.error(`No difficulty found for pass ${pass.id}`);
                      return;
                    }
  
                    // Create properly structured level data for score calculation
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
                        transaction: recalcTransaction,
                      },
                    );
                  }),
                );
              }
  
              // Schedule stats update for affected players
              const affectedPlayerIds = new Set(
                passes.map(pass => pass.playerId),
              );
              playerStatsService.updatePlayerStats(Array.from(affectedPlayerIds));
            }
  
            await recalcTransaction.commit();
  
            // Broadcast updates
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
            await recalcTransaction.rollback();
            throw error;
          }
        } catch (error) {
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
      return;
    } catch (error) {
      await transaction.rollback();
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
        await transaction.rollback();
        return res.status(400).json({error: 'Invalid level ID'});
      }
  
      // Get the level
      const level = await Level.findByPk(levelId, {transaction});
      if (!level) {
        await transaction.rollback();
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
      await transaction.rollback();
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
        return;
      } catch (error) {
        await transaction.rollback();
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
          await transaction.rollback();
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
        await handleLevelUpdate();
  
        return res.json({
          message: 'Level restored successfully',
          level: level,
        });
      } catch (error) {
        await transaction.rollback();
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
        await transaction.rollback();
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
      await transaction.rollback();
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
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const levelId = parseInt(req.params.id);
      const { action } = req.body;
  
      if (isNaN(levelId) || !Number.isInteger(levelId) || levelId <= 0) {
        return res.status(400).json({ error: 'Invalid level ID' });
      }
  
      if (!action || !['like', 'unlike'].includes(action)) {
        return res.status(400).json({ error: 'Invalid action. Must be "like" or "unlike"' });
      }
  
      // Check if level exists
      const level = await Level.findByPk(levelId, { transaction });
      if (!level) {
        await transaction.rollback();
        return res.status(404).json({ error: 'Level not found' });
      }
  
      // Check if level is deleted
      if (level.isDeleted) {
        await transaction.rollback();
        return res.status(403).json({ error: 'Cannot like deleted level' });
      }
  
      // Check if user already liked the level
      const existingLike = await LevelLikes.findOne({
        where: { levelId, userId: req.user?.id },
      });
  
      if (action === 'like') {
        if (existingLike) {
          await transaction.rollback();
          return res.status(400).json({ error: 'You have already liked this level' });
        }
  
        // Add like
        await LevelLikes.create({
          levelId,
          userId: req.user?.id,
        });
      } else {
        if (!existingLike) {
          await transaction.rollback();
          return res.status(400).json({ error: 'You have not liked this level' });
        }
  
        // Remove like
        await LevelLikes.destroy({
          where: { levelId, userId: req.user?.id },
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
      await transaction.rollback();
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
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (vote === undefined || isNaN(vote) || !Number.isInteger(vote)) {
      return res.status(400).json({ error: 'Invalid vote value' });
    }

    if (-5 > vote || vote > 5) {
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
      await transaction.rollback();
      return res.status(404).json({ error: 'Level not found' });
    }
    if (level.difficulty?.type !== "PGU") {
      await transaction.rollback();
      return res.status(400).json({ error: 'You cannot vote on a non-PGU level' });
    }
    const isPassed = await Pass.findOne({
      where: {
        levelId: id,
        playerId: req.user?.playerId,
      },
    });

    if (!isPassed) {
      await transaction.rollback();
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

    await transaction.commit();

    await level.reload()
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
        votes: req.user?.isSuperAdmin ? votes : undefined });
  } catch (error) {
    await transaction.rollback();
    logger.error('Error voting on rating accuracy:', error);
    return res.status(500).json({ error: 'Failed to vote on rating accuracy' });
  }
})

export default router;
