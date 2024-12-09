'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Example: Add a new column to the levels table
    await queryInterface.addColumn('levels', 'sampleField', {
      type: Sequelize.STRING,
      allowNull: true,
      after: 'id' // MySQL specific, places column after 'id'
    });
  },

  async down(queryInterface, Sequelize) {
    // Revert the changes
    await queryInterface.removeColumn('levels', 'sampleField');
  }
}; 