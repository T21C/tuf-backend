'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const tables = await queryInterface.showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));

      if (!names.includes('chart_clear_notification_mutes')) {
        await queryInterface.createTable(
          'chart_clear_notification_mutes',
          {
            userId: {
              type: Sequelize.UUID,
              allowNull: false,
              primaryKey: true,
              references: {model: 'users', key: 'id'},
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            levelId: {
              type: Sequelize.INTEGER,
              allowNull: false,
              primaryKey: true,
              references: {model: 'levels', key: 'id'},
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            createdAt: {
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
      if (names.includes('chart_clear_notification_mutes')) {
        await queryInterface.dropTable('chart_clear_notification_mutes', {transaction});
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
