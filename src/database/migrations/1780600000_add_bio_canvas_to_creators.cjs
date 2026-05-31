'use strict';

/** Bio canvas block document + CDN image assets for creator profiles (mirrors players). */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn(
        'creators',
        'bioCanvas',
        {
          type: Sequelize.JSON,
          allowNull: true,
        },
        { transaction },
      );
      await queryInterface.addColumn(
        'creators',
        'bioCanvasImageAssets',
        {
          type: Sequelize.JSON,
          allowNull: true,
        },
        { transaction },
      );
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.removeColumn('creators', 'bioCanvasImageAssets', { transaction });
      await queryInterface.removeColumn('creators', 'bioCanvas', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
