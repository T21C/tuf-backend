'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('level_requests');
    if (table.discordThreadClosed) return;
    await queryInterface.addColumn('level_requests', 'discordThreadClosed', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('level_requests');
    if (!table.discordThreadClosed) return;
    await queryInterface.removeColumn('level_requests', 'discordThreadClosed');
  },
};
