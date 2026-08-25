'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const tables = await queryInterface.showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));

      if (!names.includes('notification_user_settings')) {
        await queryInterface.createTable(
          'notification_user_settings',
          {
            userId: {
              type: Sequelize.UUID,
              allowNull: false,
              primaryKey: true,
              references: {model: 'users', key: 'id'},
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            pushEnabled: {
              type: Sequelize.BOOLEAN,
              allowNull: false,
              defaultValue: false,
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

      if (!names.includes('push_subscriptions')) {
        await queryInterface.createTable(
          'push_subscriptions',
          {
            id: {
              type: Sequelize.INTEGER.UNSIGNED,
              autoIncrement: true,
              primaryKey: true,
              allowNull: false,
            },
            userId: {
              type: Sequelize.UUID,
              allowNull: false,
              references: {model: 'users', key: 'id'},
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            endpoint: {
              type: Sequelize.STRING(512),
              allowNull: false,
            },
            p256dh: {
              type: Sequelize.STRING(255),
              allowNull: false,
            },
            auth: {
              type: Sequelize.STRING(255),
              allowNull: false,
            },
            expirationTime: {
              type: Sequelize.DATE,
              allowNull: true,
            },
            userAgent: {
              type: Sequelize.STRING(512),
              allowNull: true,
            },
            locale: {
              type: Sequelize.STRING(16),
              allowNull: false,
              defaultValue: 'en',
            },
            createdAt: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
            },
            lastSeenAt: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
            },
          },
          {transaction},
        );

        await queryInterface.addIndex('push_subscriptions', ['endpoint'], {
          name: 'push_subscriptions_endpoint',
          unique: true,
          transaction,
        });
        await queryInterface.addIndex('push_subscriptions', ['userId'], {
          name: 'push_subscriptions_user_id',
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
      if (names.includes('push_subscriptions')) {
        await queryInterface.dropTable('push_subscriptions', {transaction});
      }
      if (names.includes('notification_user_settings')) {
        await queryInterface.dropTable('notification_user_settings', {transaction});
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
