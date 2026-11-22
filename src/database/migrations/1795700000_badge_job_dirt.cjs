'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('badge_jobs');
    if (!table.dirt) {
      await queryInterface.addColumn('badge_jobs', 'dirt', { type: Sequelize.JSON, allowNull: true });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('badge_jobs');
    if (table.dirt) await queryInterface.removeColumn('badge_jobs', 'dirt');
  },
};
