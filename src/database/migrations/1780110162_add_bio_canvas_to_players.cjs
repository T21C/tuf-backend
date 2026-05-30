'use strict';

/** Bio canvas block document + CDN image assets for player profiles. */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn(
        'players',
        'bioCanvas',
        {
          type: Sequelize.JSON,
          allowNull: true,
        },
        { transaction },
      );
      await queryInterface.addColumn(
        'players',
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
      await queryInterface.removeColumn('players', 'bioCanvasImageAssets', { transaction });
      await queryInterface.removeColumn('players', 'bioCanvas', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
