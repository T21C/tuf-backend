import sequelize from '../config/db.js';
import Level from '../models/Level.js';
import Pass from '../models/Pass.js';
import Player from '../models/Player.js';
import {Op} from 'sequelize';
import {initializeAssociations} from '../models/associations.js';

// Initialize associations before running the script

async function syncClearCounts() {
  const transaction = await sequelize.transaction();

  try {
    console.log('Starting clear count synchronization...');

    // Get all levels that have at least one pass
    const levelsWithPasses = await Pass.findAll({
      attributes: [[sequelize.fn('DISTINCT', sequelize.col('levelId')), 'levelId']],
      raw: true
    });

    const levelIds = levelsWithPasses.map((level: any) => level.levelId);
    console.log(`Found ${levelIds.length} levels with passes to process`);

    if (levelIds.length === 0) {
      console.log('No levels found to process');
      await transaction.rollback();
      return;
    }

    // Get clear counts for all levels in a single query, excluding banned players
    const clearCounts = await Pass.findAll({
      attributes: [
        'levelId',
        [sequelize.fn('COUNT', sequelize.col('Pass.id')), 'clearCount']
      ],
      where: {
        levelId: {
          [Op.in]: levelIds
        },
        isDeleted: false,
        isHidden: false
      },
      include: [{
        model: Player,
        as: 'player',
        where: {isBanned: false},
        attributes: []
      }],
      group: ['levelId'],
      raw: true,
      transaction
    });

    // Create a map of levelId to clearCount
    const clearCountMap = clearCounts.reduce((acc: {[key: number]: number}, curr: any) => {
      acc[curr.levelId] = parseInt(curr.clearCount);
      return acc;
    }, {});

    // Update all levels in a single query
    await Level.update(
      {
        clears: sequelize.literal(`CASE 
          ${levelIds.map(id => `WHEN id = ${id} THEN ${clearCountMap[id] || 0}`).join(' ')}
          ELSE clears END`),
        isCleared: sequelize.literal(`CASE 
          ${levelIds.map(id => `WHEN id = ${id} THEN ${clearCountMap[id] ? 'TRUE' : 'FALSE'}`).join(' ')}
          ELSE isCleared END`)
      },
      {
        where: {
          id: {
            [Op.in]: levelIds
          }
        },
        transaction
      }
    );

    // Get the results of the update for logging
    const updatedLevels = await Level.findAll({
      where: {
        id: {
          [Op.in]: levelIds
        }
      },
      attributes: ['id', 'clears', 'isCleared'],
      transaction
    });

    console.log('\nUpdate summary:');
    updatedLevels.forEach(level => {
      console.log(`Level ${level.id}: ${level.clears} clears, isCleared: ${level.isCleared}`);
    });

    await transaction.commit();
    console.log('\nClear count synchronization completed successfully!');

  } catch (error) {
    await transaction.rollback();
    console.error('Error during clear count synchronization:', error);
    throw error;
  }
}

// Execute the script
sequelize.authenticate()
  .then(() => {
    initializeAssociations();
    console.log('Database connection established successfully.');
    return syncClearCounts();
  })
  .then(() => {
    console.log('Script completed successfully.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  }); 