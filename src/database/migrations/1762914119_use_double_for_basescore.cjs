'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // First change baseScore to DOUBLE
    await queryInterface.changeColumn('levels', 'baseScore', {
      type: Sequelize.DOUBLE,
      allowNull: true,
      defaultValue: null
    });

    // Then change previousBaseScore to DOUBLE
    await queryInterface.changeColumn('levels', 'previousBaseScore', {
      type: Sequelize.DOUBLE,
      allowNull: true,
      defaultValue: null
    });
  },

  async down(queryInterface, Sequelize) {
    // Revert baseScore back to INTEGER
    await queryInterface.changeColumn('levels', 'baseScore', {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: null
    });

    // Revert previousBaseScore back to INTEGER
    await queryInterface.changeColumn('levels', 'previousBaseScore', {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: null
    });

  }
}; 