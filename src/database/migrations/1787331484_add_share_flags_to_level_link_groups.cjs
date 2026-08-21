'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('level_link_groups', 'shareChart', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment:
        'When true, each creator keeps only their highest C-family curation tier among group members',
    });
    await queryInterface.addColumn('level_link_groups', 'shareVfx', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment:
        'When true, each creator keeps only their highest V-family curation tier among group members',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('level_link_groups', 'shareVfx');
    await queryInterface.removeColumn('level_link_groups', 'shareChart');
  },
};
