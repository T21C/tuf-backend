'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('badge_jobs');
    if (!table.currentDefinitionId) {
      await queryInterface.addColumn('badge_jobs', 'currentDefinitionId', { type: Sequelize.INTEGER, allowNull: true });
    }
    if (!table.currentOwnerId) {
      await queryInterface.addColumn('badge_jobs', 'currentOwnerId', { type: Sequelize.INTEGER, allowNull: true });
    }
    if (!table.heartbeatAt) {
      await queryInterface.addColumn('badge_jobs', 'heartbeatAt', { type: Sequelize.DATE, allowNull: true });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('badge_jobs');
    for (const name of ['heartbeatAt', 'currentOwnerId', 'currentDefinitionId']) {
      if (table[name]) await queryInterface.removeColumn('badge_jobs', name);
    }
  },
};
