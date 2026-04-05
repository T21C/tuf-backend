'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('curation_types', 'group', {
      type: Sequelize.STRING(255),
      allowNull: true,
      defaultValue: null,
      comment: 'Optional group name for organizing curation types (same semantics as level_tags.group)',
    });
    await queryInterface.addColumn('curation_types', 'groupSortOrder', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Sort order for curation type groups display',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('curation_types', 'groupSortOrder');
    await queryInterface.removeColumn('curation_types', 'group');
  },
};
