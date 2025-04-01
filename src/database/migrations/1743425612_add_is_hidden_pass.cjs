'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('passes', 'isHidden', {
      type: Sequelize.BOOLEAN,
      allowNull: true,
      defaultValue: false
    });

    // Add an index for faster queries
    await queryInterface.addIndex('passes', ['isHidden']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('passes', ['isHidden']);
    await queryInterface.removeColumn('passes', 'isHidden');
  }
}; 