'use strict';

/** Adds profile header surface style + optional CDN background image on `players` and `creators`. */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      for (const table of ['players', 'creators']) {
        await queryInterface.addColumn(
          table,
          'profileHeaderSurfaceStyle',
          {
            type: Sequelize.JSON,
            allowNull: true,
          },
          { transaction },
        );
        await queryInterface.addColumn(
          table,
          'profileHeaderSurfaceImageId',
          {
            type: Sequelize.STRING(64),
            allowNull: true,
          },
          { transaction },
        );
        await queryInterface.addColumn(
          table,
          'profileHeaderSurfaceImageUrl',
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
        await queryInterface.removeColumn(table, 'profileHeaderSurfaceStyle', { transaction });
        await queryInterface.removeColumn(table, 'profileHeaderSurfaceImageId', { transaction });
        await queryInterface.removeColumn(table, 'profileHeaderSurfaceImageUrl', { transaction });
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
