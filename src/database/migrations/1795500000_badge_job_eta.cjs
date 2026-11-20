'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('badge_jobs');
    if (!table.etaMs) {
      await queryInterface.addColumn('badge_jobs', 'etaMs', { type: Sequelize.INTEGER, allowNull: true });
    }
    if (!table.etaSamples) {
      await queryInterface.addColumn('badge_jobs', 'etaSamples', { type: Sequelize.JSON, allowNull: true });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('badge_jobs');
    for (const name of ['etaSamples', 'etaMs']) {
      if (table[name]) await queryInterface.removeColumn('badge_jobs', name);
    }
  },
};
