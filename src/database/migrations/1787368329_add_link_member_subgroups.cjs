'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('level_link_members', 'chartSubgroup', {
      type: Sequelize.TINYINT.UNSIGNED,
      allowNull: true,
      defaultValue: null,
      comment:
        'Chart share pool (C/O). Same non-null id among 2+ members shares; null = no share',
    });
    await queryInterface.addColumn('level_link_members', 'vfxSubgroup', {
      type: Sequelize.TINYINT.UNSIGNED,
      allowNull: true,
      defaultValue: null,
      comment:
        'VFX share pool (V). Same non-null id among 2+ members shares; null = no share',
    });

    await queryInterface.sequelize.query(`
      UPDATE level_link_members AS m
      INNER JOIN level_link_groups AS g ON g.id = m.groupId
      SET m.chartSubgroup = 1
      WHERE IFNULL(g.shareChart, 0) = 1
    `);
    await queryInterface.sequelize.query(`
      UPDATE level_link_members AS m
      INNER JOIN level_link_groups AS g ON g.id = m.groupId
      SET m.vfxSubgroup = 1
      WHERE IFNULL(g.shareVfx, 0) = 1
    `);

    await queryInterface.removeColumn('level_link_groups', 'shareVfx');
    await queryInterface.removeColumn('level_link_groups', 'shareChart');
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.addColumn('level_link_groups', 'shareChart', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await queryInterface.addColumn('level_link_groups', 'shareVfx', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });

    await queryInterface.sequelize.query(`
      UPDATE level_link_groups AS g
      SET g.shareChart = 1
      WHERE EXISTS (
        SELECT 1 FROM level_link_members AS m
        WHERE m.groupId = g.id AND m.chartSubgroup IS NOT NULL
      )
    `);
    await queryInterface.sequelize.query(`
      UPDATE level_link_groups AS g
      SET g.shareVfx = 1
      WHERE EXISTS (
        SELECT 1 FROM level_link_members AS m
        WHERE m.groupId = g.id AND m.vfxSubgroup IS NOT NULL
      )
    `);

    await queryInterface.removeColumn('level_link_members', 'vfxSubgroup');
    await queryInterface.removeColumn('level_link_members', 'chartSubgroup');
  },
};
