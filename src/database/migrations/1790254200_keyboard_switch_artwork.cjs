'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('keyboard_switches', 'stem', {
      type: Sequelize.STRING(16),
      allowNull: true,
    });
    await queryInterface.addColumn('keyboard_switches', 'baseColor', {
      type: Sequelize.STRING(7),
      allowNull: true,
    });
    await queryInterface.addColumn('keyboard_switches', 'stemColor', {
      type: Sequelize.STRING(7),
      allowNull: true,
    });
    await queryInterface.addColumn('keyboard_switches', 'baseOpacity', {
      type: Sequelize.DECIMAL(3, 2),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('keyboard_switches', 'baseOpacity');
    await queryInterface.removeColumn('keyboard_switches', 'stemColor');
    await queryInterface.removeColumn('keyboard_switches', 'baseColor');
    await queryInterface.removeColumn('keyboard_switches', 'stem');
  },
};
