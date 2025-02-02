'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('passes', 'isDuplicate', {
      type: Sequelize.BOOLEAN,
      allowNull: true,
      defaultValue: false,
      comment: 'Indicates if this pass is a duplicate clear of another level (e.g. same chart uploaded multiple times)'
    });

    // Add an index for faster queries
    await queryInterface.addIndex('passes', ['isDuplicate']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('passes', ['isDuplicate']);
    await queryInterface.removeColumn('passes', 'isDuplicate');
  }
}; 