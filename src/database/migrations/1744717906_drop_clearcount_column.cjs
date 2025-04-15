'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // First change baseScore to DOUBLE
    await queryInterface.removeColumn('levels', 'clears');

  },

  async down(queryInterface, Sequelize) {
    // Revert baseScore back to INTEGER
    await queryInterface.addColumn('levels', 'clears', {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: 0
    });

  }
}; 