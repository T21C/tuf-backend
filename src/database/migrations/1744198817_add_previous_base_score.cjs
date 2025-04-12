'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('levels', 'previousBaseScore', {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: null
    });

    // Add an index for faster queries
    await queryInterface.addIndex('levels', ['previousBaseScore']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('levels', ['previousBaseScore']);
    await queryInterface.removeColumn('levels', 'previousBaseScore');
  }
}; 