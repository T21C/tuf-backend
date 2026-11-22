'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('badge_jobs');
    if (!table.ownerKind) {
      await queryInterface.addColumn('badge_jobs', 'ownerKind', { type: Sequelize.STRING(16), allowNull: true });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('badge_jobs');
    if (table.ownerKind) await queryInterface.removeColumn('badge_jobs', 'ownerKind');
  },
};
