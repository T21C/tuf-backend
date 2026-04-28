'use strict';

/**
 * Drops OAuth token and profile blob columns from user_oauth_providers.
 * Login uses authorization-code flow only; linkage is (provider, providerId).
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const table = 'user_oauth_providers';
      for (const column of ['accessToken', 'refreshToken', 'tokenExpiry', 'profile']) {
        await queryInterface.removeColumn(table, column, { transaction });
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
      const table = 'user_oauth_providers';
      await queryInterface.addColumn(
        table,
        'accessToken',
        { type: Sequelize.TEXT, allowNull: true },
        { transaction },
      );
      await queryInterface.addColumn(
        table,
        'refreshToken',
        { type: Sequelize.TEXT, allowNull: true },
        { transaction },
      );
      await queryInterface.addColumn(
        table,
        'tokenExpiry',
        { type: Sequelize.DATE, allowNull: true },
        { transaction },
      );
      await queryInterface.addColumn(
        table,
        'profile',
        { type: Sequelize.JSON, allowNull: false, defaultValue: {} },
        { transaction },
      );
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
