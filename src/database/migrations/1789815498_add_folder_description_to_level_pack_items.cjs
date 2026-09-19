'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('level_pack_items', 'description', {
      type: Sequelize.TEXT,
      allowNull: true,
      comment: 'Optional website-only plain-text description of a folder (null for levels)',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('level_pack_items', 'description');
  },
};
