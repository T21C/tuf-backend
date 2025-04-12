'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('levels', 'previousBaseScore', {
      type: Sequelize.DOUBLE,
      allowNull: true,
      defaultValue: null
    });

  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('levels', 'previousBaseScore');
  }
}; 