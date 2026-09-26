'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('keyboard_switches', 'topColor', {
      type: Sequelize.STRING(7),
      allowNull: true,
    });
    await queryInterface.addColumn('keyboard_board_periods', 'topColor', {
      type: Sequelize.STRING(7),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('keyboard_board_periods', 'topColor');
    await queryInterface.removeColumn('keyboard_switches', 'topColor');
  },
};
