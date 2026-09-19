'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('levels', 'description', {
      type: Sequelize.TEXT,
      allowNull: true,
      comment: 'Optional website-only plain-text description of the level',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('levels', 'description');
  },
};
