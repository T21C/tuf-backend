'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('level_packs', 'description', {
      type: Sequelize.TEXT,
      allowNull: true,
      comment: 'Optional plain-text description of the pack',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('level_packs', 'description');
  },
};
