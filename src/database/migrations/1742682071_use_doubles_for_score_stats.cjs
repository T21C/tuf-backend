'use strict';

// NAMING CONVENTION:
// tables: table_name
// columns: columnName

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Example: Add a new column to the levels table
      await queryInterface.changeColumn('player_stats', 'rankedScore', {
        type: Sequelize.DOUBLE,
        allowNull: true,
      }, { transaction });

      await queryInterface.changeColumn('player_stats', 'generalScore', {
        type: Sequelize.DOUBLE,
        allowNull: true,
      }, { transaction });

      await queryInterface.changeColumn('player_stats', 'ppScore', {
        type: Sequelize.DOUBLE,
        allowNull: true,
      }, { transaction });

      await queryInterface.changeColumn('player_stats', 'wfScore', {
        type: Sequelize.DOUBLE,
        allowNull: true,
      }, { transaction });

      await queryInterface.changeColumn('player_stats', 'score12K', {
        type: Sequelize.DOUBLE,
        allowNull: true,
      }, { transaction });

      await queryInterface.changeColumn('player_stats', 'averageXacc', {
        type: Sequelize.DOUBLE,
        allowNull: true,
      }, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Revert the changes
      await queryInterface.changeColumn('player_stats', 'rankedScore', {
        type: Sequelize.FLOAT,
        allowNull: true,
      }, { transaction });

      await queryInterface.changeColumn('player_stats', 'generalScore', {
        type: Sequelize.FLOAT,
        allowNull: true,
      }, { transaction });  

      await queryInterface.changeColumn('player_stats', 'ppScore', {
        type: Sequelize.FLOAT,
        allowNull: true,
      }, { transaction });
      
      await queryInterface.changeColumn('player_stats', 'wfScore', {
        type: Sequelize.FLOAT,  
        allowNull: true,
      }, { transaction });

      await queryInterface.changeColumn('player_stats', 'score12K', {
        type: Sequelize.FLOAT,
        allowNull: true,
      }, { transaction });

      await queryInterface.changeColumn('player_stats', 'averageXacc', {
        type: Sequelize.FLOAT,
        allowNull: true,
      }, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
}; 