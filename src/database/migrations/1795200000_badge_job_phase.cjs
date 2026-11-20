'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('badge_jobs');
    if (!table.phase) {
      await queryInterface.addColumn('badge_jobs', 'phase', { type: Sequelize.STRING(16), allowNull: true });
    }
    if (!table.badgeCursor) {
      await queryInterface.addColumn('badge_jobs', 'badgeCursor', {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      });
    }
    if (!table.badgeTotal) {
      await queryInterface.addColumn('badge_jobs', 'badgeTotal', {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('badge_jobs');
    for (const name of ['badgeTotal', 'badgeCursor', 'phase']) {
      if (table[name]) await queryInterface.removeColumn('badge_jobs', name);
    }
  },
};
