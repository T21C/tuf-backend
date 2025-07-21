'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('difficulties', `type`, {
      type: Sequelize.ENUM('PGU', 'SPECIAL', 'LEGACY'),
      allowNull: false,
      defaultValue: 'PGU'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn('difficulties', `type`, {
      type: Sequelize.ENUM('PGU', 'SPECIAL'),
      allowNull: false,
      defaultValue: 'PGU'
    });
  }
};