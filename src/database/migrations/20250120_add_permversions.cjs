'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Example: Add a new column to the levels table
    await queryInterface.addColumn('users', 'permissionVersion', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 1
    });
  },

  async down(queryInterface, Sequelize) {
    // Revert the changes
    await queryInterface.removeColumn('users', 'permissionVersion');
  }
}; 