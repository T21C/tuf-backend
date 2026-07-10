'use strict';

/** Drops legacy presentation columns from players/creators after piece cutover. */

const columns = [
  'bio',
  'bioCanvas',
  'bioCanvasImageAssets',
  'bannerPreset',
  'customBannerId',
  'customBannerUrl',
  'profileHeaderSurfaceStyle',
  'profileHeaderSurfaceImageAssets',
  'tufStellarIconVariant',
];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      for (const table of ['players', 'creators']) {
        for (const column of columns) {
          await queryInterface.removeColumn(table, column, { transaction });
        }
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      for (const table of ['players', 'creators']) {
        await queryInterface.addColumn(table, 'bio', { type: Sequelize.TEXT, allowNull: true }, { transaction });
        await queryInterface.addColumn(
          table,
          'bioCanvas',
          { type: Sequelize.JSON, allowNull: true },
          { transaction },
        );
        await queryInterface.addColumn(
          table,
          'bioCanvasImageAssets',
          { type: Sequelize.JSON, allowNull: true },
          { transaction },
        );
        await queryInterface.addColumn(
          table,
          'bannerPreset',
          { type: Sequelize.TEXT, allowNull: true },
          { transaction },
        );
        await queryInterface.addColumn(
          table,
          'customBannerId',
          { type: Sequelize.STRING(64), allowNull: true },
          { transaction },
        );
        await queryInterface.addColumn(
          table,
          'customBannerUrl',
          { type: Sequelize.TEXT, allowNull: true },
          { transaction },
        );
        await queryInterface.addColumn(
          table,
          'profileHeaderSurfaceStyle',
          { type: Sequelize.JSON, allowNull: true },
          { transaction },
        );
        await queryInterface.addColumn(
          table,
          'profileHeaderSurfaceImageAssets',
          { type: Sequelize.JSON, allowNull: true },
          { transaction },
        );
        await queryInterface.addColumn(
          table,
          'tufStellarIconVariant',
          { type: Sequelize.STRING(1), allowNull: false, defaultValue: '1' },
          { transaction },
        );
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
