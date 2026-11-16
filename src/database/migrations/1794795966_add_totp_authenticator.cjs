'use strict';

/**
 * Authenticator-app TOTP columns on users plus hashed recovery codes.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const desc = await queryInterface.describeTable('users');

      if (!desc.totpSecretEnc) {
        await queryInterface.addColumn(
          'users',
          'totpSecretEnc',
          {
            type: Sequelize.TEXT,
            allowNull: true,
            defaultValue: null,
          },
          {transaction},
        );
      }
      if (!desc.totpPendingSecretEnc) {
        await queryInterface.addColumn(
          'users',
          'totpPendingSecretEnc',
          {
            type: Sequelize.TEXT,
            allowNull: true,
            defaultValue: null,
          },
          {transaction},
        );
      }
      if (!desc.totpEnabled) {
        await queryInterface.addColumn(
          'users',
          'totpEnabled',
          {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: false,
          },
          {transaction},
        );
      }
      if (!desc.totpLastAcceptedStep) {
        await queryInterface.addColumn(
          'users',
          'totpLastAcceptedStep',
          {
            type: Sequelize.BIGINT,
            allowNull: true,
            defaultValue: null,
          },
          {transaction},
        );
      }

      const tables = await queryInterface.showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));
      if (!names.includes('totp_recovery_codes')) {
        await queryInterface.createTable(
          'totp_recovery_codes',
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
              references: {model: 'users', key: 'id'},
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            codeHash: {
              type: Sequelize.STRING(64),
              allowNull: false,
            },
            usedAt: {
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
          {transaction},
        );

        await queryInterface.addIndex('totp_recovery_codes', ['userId'], {
          name: 'totp_recovery_codes_user_id',
          transaction,
        });
        await queryInterface.addIndex('totp_recovery_codes', ['userId', 'codeHash'], {
          name: 'totp_recovery_codes_user_id_code_hash',
          unique: true,
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
      if (names.includes('totp_recovery_codes')) {
        await queryInterface.dropTable('totp_recovery_codes', {transaction});
      }

      const desc = await queryInterface.describeTable('users');
      if (desc.totpLastAcceptedStep) {
        await queryInterface.removeColumn('users', 'totpLastAcceptedStep', {transaction});
      }
      if (desc.totpEnabled) {
        await queryInterface.removeColumn('users', 'totpEnabled', {transaction});
      }
      if (desc.totpPendingSecretEnc) {
        await queryInterface.removeColumn('users', 'totpPendingSecretEnc', {transaction});
      }
      if (desc.totpSecretEnc) {
        await queryInterface.removeColumn('users', 'totpSecretEnc', {transaction});
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
