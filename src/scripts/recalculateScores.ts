import sequelize from '../config/db.js';
import Level from '../models/levels/Level.js';
import Pass from '../models/passes/Pass.js';
import Player from '../models/players/Player.js';
import { Op } from 'sequelize';
import { initializeAssociations } from '../models/associations.js';
import { getScoreV2 } from '../utils/CalcScore.js';
import type { IJudgements } from '../utils/CalcAcc.js';
import Difficulty from '../models/levels/Difficulty.js';
import Judgement from '../models/passes/Judgement.js';
import User from '../models/auth/User.js';
import { logger } from '../services/LoggerService.js';
import { safeTransactionRollback } from '../utils/Utility.js';
import { wherePermission } from '../utils/permissionUtils.js';
import { permissionFlags } from '../config/constants.js';

// Configuration
const BATCH_SIZE = 1000; // Process levels in batches to avoid memory issues
const CONFIRMATION_REQUIRED = false; // Set to false to skip confirmation prompt

async function recalculateScores() {
  const transaction = await sequelize.transaction();

  try {
    logger.info('Starting score recalculation...');
    logger.info('This script will recalculate scoreV2 for all passes using the current formula.');

    if (CONFIRMATION_REQUIRED) {
      logger.info('\nWARNING: This operation will update scoreV2 for all passes in the database.');
      logger.info('Make sure you have backed up your database before proceeding.');
      logger.info('Press Ctrl+C to cancel or wait 5 seconds to continue...');

      // Wait for 5 seconds to allow cancellation
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    // Get all passes
    const totalPasses = await Pass.count({
      where: { isDeleted: false },
      transaction
    });
    logger.info(`Found ${totalPasses} total passes to process`);

    // Process passes in batches
    let processedCount = 0;
    let updatedCount = 0;
    let errorCount = 0;

    for (let offset = 0; offset < totalPasses; offset += BATCH_SIZE) {
      const passes = await Pass.findAll({
        limit: BATCH_SIZE,
        offset,
        where: { isDeleted: false },
        include: [{
          model: Level,
          as: 'level',
          required: true,
          include: [{
            model: Difficulty,
            as: 'difficulty',
            required: true
          }]
        }, {
          model: Player,
          as: 'player',
          required: true,
          include: [
            {
              model: User,
              as: 'user',
              required: false,
              where: {
                [Op.and]: [
                  wherePermission(permissionFlags.BANNED, false)
                ]
              }
            }
          ]
        },
        {
          model: Judgement,
          as: 'judgements',
          required: true
        }],

        transaction
      });

      logger.info(`Processing batch ${Math.floor(offset/BATCH_SIZE) + 1}/${Math.ceil(totalPasses/BATCH_SIZE)}`);

      for (const pass of passes) {
        try {
          if (!pass.level) {
            logger.error(`Pass ${pass.id} has no associated level, skipping...`);
            continue;
          }

          const defaultJudgements: IJudgements = {
            earlyDouble: 0,
            earlySingle: 0,
            ePerfect: 5,
            perfect: 40,
            lPerfect: 5,
            lateSingle: 0,
            lateDouble: 0
          };

          const passData = {
            speed: pass.speed || 1,
            judgements: pass.judgements || defaultJudgements,
            isNoHoldTap: pass.isNoHoldTap || false
          };

          const levelData = {
            baseScore: pass.level.baseScore || 0,
            difficulty: {
              name: pass.level.difficulty?.name || '',
              baseScore: pass.level.difficulty?.baseScore || 0
            }
          };

          const newScore = getScoreV2(passData, levelData);
          const currentScore = pass.scoreV2 || 0;

          // Update pass with new score
          await pass.update({
            scoreV2: newScore
          }, { transaction });

          processedCount++;

          // Log significant changes
          if (Math.abs(currentScore - newScore) > 1) {
            logger.info(`Pass ${pass.id} (Level: ${pass.level.difficulty?.name}): Score updated from ${currentScore.toFixed(2)} to ${newScore.toFixed(2)}`);
            updatedCount++;
          }
        } catch (error) {
          logger.error(`Error processing pass ${pass.id}:`, error);
          errorCount++;
        }
      }
    }

    // Log summary
    logger.info('\nRecalculation summary:');
    logger.info(`Total passes processed: ${processedCount}`);
    logger.info(`Passes with score changes: ${updatedCount}`);
    logger.info(`Errors encountered: ${errorCount}`);

    // Commit transaction
    await transaction.commit();
    logger.info('\nScore recalculation completed successfully!');

  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error during score recalculation:', error);
    throw error;
  }
}

// Execute the script
sequelize.authenticate()
  .then(() => {
    initializeAssociations();
    logger.info('Database connection established successfully.');
    return recalculateScores();
  })
  .then(() => {
    logger.info('Script completed successfully.');
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Script failed:', error);
    process.exit(1);
  });
