'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('curations', 'shortDescription', {
      type: Sequelize.STRING(255),
      allowNull: true,
      defaultValue: ""
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('curations', 'shortDescription');
  }
};
