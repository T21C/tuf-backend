import Player from '../models/players/Player.js';
import {PlayerStatsService} from '../services/PlayerStatsService.js';
import sequelize from '../config/db.js';
import { logger } from '../services/LoggerService.js';

async function populatePlayerStats() {
  const playerStatsService = PlayerStatsService.getInstance();
  const transaction = await sequelize.transaction();

  try {
    logger.info('Starting player stats population...');

    // Get all players
    const players = await Player.findAll({
      transaction,
    });

    logger.info(`Found ${players.length} players to process`);

    // Update stats for each player
    for (let i = 0; i < players.length; i++) {
      const player = players[i];
      logger.info(
        `Processing player ${i + 1}/${players.length}: ${player.name}`,
      );

      try {
        await playerStatsService.updatePlayerStats([player.id]);
        logger.info(`Successfully updated stats for player ${player.name}`);
      } catch (error) {
        logger.error(`Error updating stats for player ${player.name}:`, error);
      }
    }

    await transaction.commit();
    logger.info('Successfully populated player stats');
    return;
  } catch (error) {
    await transaction.rollback();
    logger.error('Error populating player stats:', error);
    throw error;
  }
}

populatePlayerStats()
  .then(() => {
    return;
  })
  .catch(error => {
    logger.error('Error populating player stats:', error);
    return;
  });
