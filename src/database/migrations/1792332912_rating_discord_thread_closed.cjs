'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('ratings');
    if (table.discordThreadClosed) return;
    await queryInterface.addColumn('ratings', 'discordThreadClosed', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('ratings');
    if (!table.discordThreadClosed) return;
    await queryInterface.removeColumn('ratings', 'discordThreadClosed');
  },
};
