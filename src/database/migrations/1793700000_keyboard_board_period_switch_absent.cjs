'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('keyboard_board_period_switches');
    if (!table.absent) {
      await queryInterface.addColumn('keyboard_board_period_switches', 'absent', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('keyboard_board_period_switches');
    if (table.absent) {
      await queryInterface.removeColumn('keyboard_board_period_switches', 'absent');
    }
  },
};
