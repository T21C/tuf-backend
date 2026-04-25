'use strict';

/** Adds `bannerPreset`, `customBannerId`, `customBannerUrl` on `players` and `creators`. */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      for (const table of ['players', 'creators']) {
        await queryInterface.addColumn(
          table,
          'bannerPreset',
          {
            type: Sequelize.TEXT,
            allowNull: true,
          },
          { transaction },
        );
        await queryInterface.addColumn(
          table,
          'customBannerId',
          {
            type: Sequelize.STRING(64),
            allowNull: true,
          },
          { transaction },
        );
        await queryInterface.addColumn(
          table,
          'customBannerUrl',
          {
            type: Sequelize.TEXT,
            allowNull: true,
          },
          { transaction },
        );
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      for (const table of ['players', 'creators']) {
        await queryInterface.removeColumn(table, 'bannerPreset', { transaction });
        await queryInterface.removeColumn(table, 'customBannerId', { transaction });
        await queryInterface.removeColumn(table, 'customBannerUrl', { transaction });
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
