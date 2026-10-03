'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.addColumn('passes', 'isDuplicateOverridden', {
      type: require('sequelize').BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: 'Admin changed isDuplicate; skip chart-link duplicate guesses',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('passes', 'isDuplicateOverridden');
  },
};
