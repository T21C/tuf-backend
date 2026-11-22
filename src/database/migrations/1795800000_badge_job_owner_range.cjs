'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('badge_jobs');
    if (!table.ownerFrom) {
      await queryInterface.addColumn('badge_jobs', 'ownerFrom', { type: Sequelize.INTEGER, allowNull: true });
    }
    if (!table.ownerTo) {
      await queryInterface.addColumn('badge_jobs', 'ownerTo', { type: Sequelize.INTEGER, allowNull: true });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('badge_jobs');
    for (const name of ['ownerTo', 'ownerFrom']) {
      if (table[name]) await queryInterface.removeColumn('badge_jobs', name);
    }
  },
};
