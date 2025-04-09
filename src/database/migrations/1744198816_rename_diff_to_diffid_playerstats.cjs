'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.renameColumn('player_stats', 'topDiff', 'topDiffId');
    await queryInterface.renameColumn('player_stats', 'top12kDiff', 'top12kDiffId');
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.renameColumn('player_stats', 'topDiffId', 'topDiff');
    await queryInterface.renameColumn('player_stats', 'top12kDiffId', 'top12kDiff');
  }
};