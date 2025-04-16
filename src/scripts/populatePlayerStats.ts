import Player from '../models/players/Player.js';
import {PlayerStatsService} from '../services/PlayerStatsService.js';
import sequelize from '../config/db.js';

async function populatePlayerStats() {
  const playerStatsService = PlayerStatsService.getInstance();
  const transaction = await sequelize.transaction();

  try {
    console.log('Starting player stats population...');

    // Get all players
    const players = await Player.findAll({
      transaction,
    });

    console.log(`Found ${players.length} players to process`);

    // Update stats for each player
    for (let i = 0; i < players.length; i++) {
      const player = players[i];
      console.log(
        `Processing player ${i + 1}/${players.length}: ${player.name}`,
      );

      try {
        await playerStatsService.updatePlayerStats(player.id);
        console.log(`Successfully updated stats for player ${player.name}`);
      } catch (error) {
        console.error(`Error updating stats for player ${player.name}:`, error);
      }
    }

    await transaction.commit();
    console.log('Successfully populated player stats');
    return;
  } catch (error) {
    await transaction.rollback();
    console.error('Error populating player stats:', error);
    throw error;
  }
}

populatePlayerStats()
  .then(() => {
    return;
  })
  .catch(error => {
    console.error('Error populating player stats:', error);
    return;
  });
