'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // First change baseScore to DOUBLE
    await queryInterface.removeColumn('passes', 'accuracy');

  },

  async down(queryInterface, Sequelize) {
    // Revert baseScore back to INTEGER
    await queryInterface.addColumn('passes', 'accuracy', {
      type: Sequelize.FLOAT,
      allowNull: true,
      defaultValue: 0.95
    });

  }
}; 