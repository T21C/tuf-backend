'use strict';

/**
 * Per-account client UX preferences (dismissed banners, Settings → Preferences, language).
 * Sparse JSON blob; missing keys mean product defaults.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const tables = await queryInterface.showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));

      if (!names.includes('user_client_preferences')) {
        await queryInterface.createTable(
          'user_client_preferences',
          {
            userId: {
              type: Sequelize.UUID,
              allowNull: false,
              primaryKey: true,
              references: {model: 'users', key: 'id'},
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            payload: {
              type: Sequelize.JSON,
              allowNull: false,
            },
            updatedAt: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
            },
          },
          {transaction},
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
      const tables = await queryInterface.showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));
      if (names.includes('user_client_preferences')) {
        await queryInterface.dropTable('user_client_preferences', {transaction});
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
