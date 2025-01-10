'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('PlayerStats', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      playerId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        unique: true,
        references: {
          model: 'Players',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      rankedScore: {
        type: Sequelize.FLOAT,
        allowNull: false,
        defaultValue: 0,
      },
      generalScore: {
        type: Sequelize.FLOAT,
        allowNull: false,
        defaultValue: 0,
      },
      ppScore: {
        type: Sequelize.FLOAT,
        allowNull: false,
        defaultValue: 0,
      },
      wfScore: {
        type: Sequelize.FLOAT,
        allowNull: false,
        defaultValue: 0,
      },
      score12k: {
        type: Sequelize.FLOAT,
        allowNull: false,
        defaultValue: 0,
      },
      rankedScoreRank: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      generalScoreRank: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      ppScoreRank: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      wfScoreRank: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      score12kRank: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      averageXacc: {
        type: Sequelize.FLOAT,
        allowNull: false,
        defaultValue: 0,
      },
      universalPassCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      worldsFirstCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      lastUpdated: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
    });

    // Add indexes for better query performance
    await queryInterface.addIndex('PlayerStats', ['playerId']);
    await queryInterface.addIndex('PlayerStats', ['rankedScore']);
    await queryInterface.addIndex('PlayerStats', ['generalScore']);
    await queryInterface.addIndex('PlayerStats', ['ppScore']);
    await queryInterface.addIndex('PlayerStats', ['wfScore']);
    await queryInterface.addIndex('PlayerStats', ['score12k']);
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('PlayerStats');
  },
}; 