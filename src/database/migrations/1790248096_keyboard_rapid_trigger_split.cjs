'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('keyboard_board_periods', 'rapidTriggerSplit', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await queryInterface.addColumn('keyboard_board_periods', 'rapidTriggerPressMm', {
      type: Sequelize.DECIMAL(4, 2),
      allowNull: true,
    });
    await queryInterface.addColumn('keyboard_board_periods', 'rapidTriggerReleaseMm', {
      type: Sequelize.DECIMAL(4, 2),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('keyboard_board_periods', 'rapidTriggerReleaseMm');
    await queryInterface.removeColumn('keyboard_board_periods', 'rapidTriggerPressMm');
    await queryInterface.removeColumn('keyboard_board_periods', 'rapidTriggerSplit');
  },
};
