'use strict';

/**
 * User inbox notifications and sparse per-type channel preferences.
 * Type ids live in the TypeScript registry, not a DB enum.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const tables = await queryInterface.showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));

      if (!names.includes('notifications')) {
        await queryInterface.createTable(
          'notifications',
          {
            id: {
              type: Sequelize.BIGINT.UNSIGNED,
              autoIncrement: true,
              primaryKey: true,
              allowNull: false,
            },
            userId: {
              type: Sequelize.UUID,
              allowNull: false,
              references: { model: 'users', key: 'id' },
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            type: {
              type: Sequelize.STRING(64),
              allowNull: false,
            },
            payload: {
              type: Sequelize.JSON,
              allowNull: false,
            },
            actorId: {
              type: Sequelize.UUID,
              allowNull: true,
              references: { model: 'users', key: 'id' },
              onUpdate: 'CASCADE',
              onDelete: 'SET NULL',
            },
            entityType: {
              type: Sequelize.STRING(32),
              allowNull: true,
            },
            entityId: {
              type: Sequelize.STRING(64),
              allowNull: true,
            },
            groupKey: {
              type: Sequelize.STRING(128),
              allowNull: true,
            },
            dedupKey: {
              type: Sequelize.STRING(128),
              allowNull: true,
            },
            readAt: {
              type: Sequelize.DATE,
              allowNull: true,
            },
            seenAt: {
              type: Sequelize.DATE,
              allowNull: true,
            },
            createdAt: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
            },
          },
          { transaction },
        );

        await queryInterface.addIndex('notifications', ['userId', 'createdAt'], {
          name: 'notifications_user_id_created_at',
          transaction,
        });
        await queryInterface.addIndex('notifications', ['userId', 'readAt'], {
          name: 'notifications_user_id_read_at',
          transaction,
        });
        await queryInterface.addIndex('notifications', ['userId', 'type', 'dedupKey'], {
          name: 'notifications_user_id_type_dedup_key',
          unique: true,
          transaction,
        });
      }

      if (!names.includes('notification_preferences')) {
        await queryInterface.createTable(
          'notification_preferences',
          {
            userId: {
              type: Sequelize.UUID,
              allowNull: false,
              references: { model: 'users', key: 'id' },
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            type: {
              type: Sequelize.STRING(64),
              allowNull: false,
            },
            inApp: {
              type: Sequelize.BOOLEAN,
              allowNull: false,
            },
            email: {
              type: Sequelize.BOOLEAN,
              allowNull: false,
            },
            discord: {
              type: Sequelize.BOOLEAN,
              allowNull: false,
            },
          },
          { transaction },
        );

        await queryInterface.addConstraint('notification_preferences', {
          fields: ['userId', 'type'],
          type: 'primary key',
          name: 'notification_preferences_pk',
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
      if (names.includes('notification_preferences')) {
        await queryInterface.dropTable('notification_preferences', { transaction });
      }
      if (names.includes('notifications')) {
        await queryInterface.dropTable('notifications', { transaction });
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
