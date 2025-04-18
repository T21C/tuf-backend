'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Drop existing indexes if they exist
    await queryInterface.changeColumn('player_stats', 'lastUpdated', {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.NOW,
    });

    await queryInterface.changeColumn('player_stats', 'createdAt', {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.NOW,
    });

    await queryInterface.changeColumn('player_stats', 'updatedAt', {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.NOW,
    });

    try{
      await queryInterface.addIndex('player_stats', ['rankedScore', 'id']);
    } catch (error) {
      console.error('Error adding rankedScore index to player_stats');
    }
    try{
      await queryInterface.addIndex('player_stats', ['generalScore', 'id']);
    } catch (error) {
      console.error('Error adding generalScore index to player_stats');
    }
    try{
      await queryInterface.addIndex('player_stats', ['ppScore', 'id']);
    } catch (error) {
      console.error('Error adding ppScore index to player_stats');
    }
    try{
      await queryInterface.addIndex('player_stats', ['wfScore', 'id']);
    } catch (error) {
      console.error('Error adding wfScore index to player_stats');
    }
    try{
      await queryInterface.addIndex('player_stats', ['score12K', 'id']);
    } catch (error) {
      console.error('Error adding score12K index to player_stats');
    }
    try{
      await queryInterface.addIndex('player_stats', ['averageXacc', 'id']);
    } catch (error) {
      console.error('Error adding averageXacc index to player_stats');
    }
  },

  async down(queryInterface, Sequelize) {   
    await queryInterface.removeIndex('player_stats', ['rankedScore', 'id']);
    await queryInterface.removeIndex('player_stats', ['generalScore', 'id']);
    await queryInterface.removeIndex('player_stats', ['ppScore', 'id']);
    await queryInterface.removeIndex('player_stats', ['wfScore', 'id']);
    await queryInterface.removeIndex('player_stats', ['score12K', 'id']);
    await queryInterface.removeIndex('player_stats', ['averageXacc', 'id']);
  }
}; 