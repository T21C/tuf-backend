'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('keyboard_board_periods', 'stemColor', {
      type: Sequelize.STRING(7),
      allowNull: true,
    });
    await queryInterface.addColumn('keyboard_board_periods', 'baseColor', {
      type: Sequelize.STRING(7),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('keyboard_board_periods', 'baseColor');
    await queryInterface.removeColumn('keyboard_board_periods', 'stemColor');
  },
};
