'use strict';

/** Per-layer CDN assets map for profile header surface image layers. */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      for (const table of ['players', 'creators']) {
        await queryInterface.addColumn(
          table,
          'profileHeaderSurfaceImageAssets',
          {
            type: Sequelize.JSON,
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
        await queryInterface.removeColumn(table, 'profileHeaderSurfaceImageAssets', {
          transaction,
        });
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
