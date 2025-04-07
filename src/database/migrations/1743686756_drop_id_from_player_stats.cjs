'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Drop the table completely
    await queryInterface.dropTable('player_stats');
    
    // Create the table with the new structure (id as primary key and foreign key)
    await queryInterface.createTable('player_stats', {
      id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        primaryKey: true
      },
      rankedScore: {
        type: Sequelize.DOUBLE,
        allowNull: true,
        defaultValue: 0
      },
      generalScore: {
        type: Sequelize.DOUBLE,
        allowNull: true,
        defaultValue: 0
      },
      ppScore: {
        type: Sequelize.DOUBLE,
        allowNull: true,
        defaultValue: 0
      },
      wfScore: {
        type: Sequelize.DOUBLE,
        allowNull: true,
        defaultValue: 0
      },
      score12K: {
        type: Sequelize.DOUBLE,
        allowNull: true,
        defaultValue: 0
      },
      rankedScoreRank: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      generalScoreRank: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      ppScoreRank: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      wfScoreRank: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      score12KRank: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      averageXacc: {
        type: Sequelize.DOUBLE,
        allowNull: true,
        defaultValue: 0
      },
      universalPassCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      worldsFirstCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      lastUpdated: {
        type: Sequelize.DATE,
        allowNull: false
      },
      topDiff: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      top12kDiff: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false
      }
    });
    
    // Add the foreign key constraint separately
    await queryInterface.addConstraint('player_stats', {
      fields: ['id'],
      type: 'foreign key',
      name: 'player_stats_player_id_fk',
      references: {
        table: 'players',
        field: 'id'
      },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    });
  },

  async down(queryInterface, Sequelize) {
    // Drop the table
    await queryInterface.dropTable('player_stats');
    
    // Create the table with the original structure
    await queryInterface.createTable('player_stats', {
      id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        autoIncrement: true,
        primaryKey: true
      },
      playerId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        unique: true
      },
      rankedScore: {
        type: Sequelize.DOUBLE,
        allowNull: true,
        defaultValue: 0
      },
      generalScore: {
        type: Sequelize.DOUBLE,
        allowNull: true,
        defaultValue: 0
      },
      ppScore: {
        type: Sequelize.DOUBLE,
        allowNull: true,
        defaultValue: 0
      },
      wfScore: {
        type: Sequelize.DOUBLE,
        allowNull: true,
        defaultValue: 0
      },
      score12K: {
        type: Sequelize.DOUBLE,
        allowNull: true,
        defaultValue: 0
      },
      rankedScoreRank: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      generalScoreRank: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      ppScoreRank: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      wfScoreRank: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      score12KRank: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      averageXacc: {
        type: Sequelize.DOUBLE,
        allowNull: true,
        defaultValue: 0
      },
      universalPassCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      worldsFirstCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      lastUpdated: {
        type: Sequelize.DATE,
        allowNull: false
      },
      topDiff: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      top12kDiff: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false
      }
    });
    
    // Add the foreign key constraint separately
    await queryInterface.addConstraint('player_stats', {
      fields: ['playerId'],
      type: 'foreign key',
      name: 'player_stats_player_id_fk',
      references: {
        table: 'players',
        field: 'id'
      },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    });
  }
};