'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('users', `creatorId`, {
      type: Sequelize.INTEGER,
      allowNull: true,
      unique: true,
      defaultValue: null
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('users', `creatorId`);
  }
};