'use strict';

/** Remove legacy single-image columns; surface images use profileHeaderSurfaceImageAssets only. */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      for (const table of ['players', 'creators']) {
        await queryInterface.removeColumn(table, 'profileHeaderSurfaceImageId', { transaction });
        await queryInterface.removeColumn(table, 'profileHeaderSurfaceImageUrl', { transaction });
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
        await queryInterface.addColumn(
          table,
          'profileHeaderSurfaceImageId',
          { type: Sequelize.STRING(64), allowNull: true },
          { transaction },
        );
        await queryInterface.addColumn(
          table,
          'profileHeaderSurfaceImageUrl',
          { type: Sequelize.TEXT, allowNull: true },
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
