'use strict';

/**
 * Sparse per-category inbox mute. Missing row means the category is enabled.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const tables = await queryInterface.showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));

      if (!names.includes('notification_category_preferences')) {
        await queryInterface.createTable(
          'notification_category_preferences',
          {
            userId: {
              type: Sequelize.UUID,
              allowNull: false,
              references: {model: 'users', key: 'id'},
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            category: {
              type: Sequelize.STRING(32),
              allowNull: false,
            },
            inApp: {
              type: Sequelize.BOOLEAN,
              allowNull: false,
            },
          },
          {transaction},
        );

        await queryInterface.addConstraint('notification_category_preferences', {
          fields: ['userId', 'category'],
          type: 'primary key',
          name: 'notification_category_preferences_pk',
          transaction,
        });
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
      if (names.includes('notification_category_preferences')) {
        await queryInterface.dropTable('notification_category_preferences', {transaction});
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
