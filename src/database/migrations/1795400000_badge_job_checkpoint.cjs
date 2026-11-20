'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('badge_jobs');
    if (!table.startFrom) {
      await queryInterface.addColumn('badge_jobs', 'startFrom', {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      });
    }
    if (!table.currentOwnerName) {
      await queryInterface.addColumn('badge_jobs', 'currentOwnerName', { type: Sequelize.STRING(80), allowNull: true });
    }
    if (!table.definitionTimings) {
      await queryInterface.addColumn('badge_jobs', 'definitionTimings', { type: Sequelize.JSON, allowNull: true });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('badge_jobs');
    for (const name of ['definitionTimings', 'currentOwnerName', 'startFrom']) {
      if (table[name]) await queryInterface.removeColumn('badge_jobs', name);
    }
  },
};
