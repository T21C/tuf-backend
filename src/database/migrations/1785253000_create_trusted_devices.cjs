'use strict';

/**
 * Trusted devices for login MFA skip ("remember this device").
 * Opaque cookie token is stored hashed; rows expire after TRUSTED_DEVICE_TTL_DAYS.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const tables = await queryInterface.showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));
      if (!names.includes('trusted_devices')) {
        await queryInterface.createTable(
          'trusted_devices',
          {
            id: {
              type: Sequelize.UUID,
              defaultValue: Sequelize.UUIDV4,
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
            tokenHash: {
              type: Sequelize.STRING(64),
              allowNull: false,
            },
            userAgent: {
              type: Sequelize.TEXT,
              allowNull: true,
            },
            ip: {
              type: Sequelize.STRING(45),
              allowNull: true,
            },
            lastUsedAt: {
              type: Sequelize.DATE,
              allowNull: false,
            },
            expiresAt: {
              type: Sequelize.DATE,
              allowNull: false,
            },
            revokedAt: {
              type: Sequelize.DATE,
              allowNull: true,
              defaultValue: null,
            },
            createdAt: {
              type: Sequelize.DATE,
              allowNull: false,
            },
            updatedAt: {
              type: Sequelize.DATE,
              allowNull: false,
            },
          },
          { transaction },
        );

        await queryInterface.addIndex('trusted_devices', ['tokenHash'], {
          name: 'trusted_devices_token_hash',
          unique: true,
          transaction,
        });
        await queryInterface.addIndex('trusted_devices', ['userId'], {
          name: 'trusted_devices_user_id',
          transaction,
        });
        await queryInterface.addIndex('trusted_devices', ['expiresAt'], {
          name: 'trusted_devices_expires',
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
      if (names.includes('trusted_devices')) {
        await queryInterface.dropTable('trusted_devices', { transaction });
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
