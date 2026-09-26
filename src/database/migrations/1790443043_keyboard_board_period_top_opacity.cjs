'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('keyboard_board_periods', 'baseOpacity', {
      type: Sequelize.DECIMAL(3, 2),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('keyboard_board_periods', 'baseOpacity');
  },
};
