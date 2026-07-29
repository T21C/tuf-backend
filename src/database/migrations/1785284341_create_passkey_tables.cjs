'use strict';

/**
 * WebAuthn passkey credentials and short-lived challenges.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const tables = await queryInterface.showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));

      if (!names.includes('passkey_credentials')) {
        await queryInterface.createTable(
          'passkey_credentials',
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
            credentialId: {
              type: Sequelize.STRING(255),
              allowNull: false,
            },
            publicKey: {
              type: Sequelize.BLOB,
              allowNull: false,
            },
            signCount: {
              type: Sequelize.BIGINT,
              allowNull: false,
              defaultValue: 0,
            },
            transports: {
              type: Sequelize.STRING(255),
              allowNull: true,
              defaultValue: null,
            },
            deviceType: {
              type: Sequelize.STRING(32),
              allowNull: true,
              defaultValue: null,
            },
            backedUp: {
              type: Sequelize.BOOLEAN,
              allowNull: false,
              defaultValue: false,
            },
            name: {
              type: Sequelize.STRING(64),
              allowNull: false,
            },
            lastUsedAt: {
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

        await queryInterface.addIndex('passkey_credentials', ['credentialId'], {
          name: 'passkey_credentials_credential_id',
          unique: true,
          transaction,
        });
        await queryInterface.addIndex('passkey_credentials', ['userId'], {
          name: 'passkey_credentials_user_id',
          transaction,
        });
      }

      if (!names.includes('webauthn_challenges')) {
        await queryInterface.createTable(
          'webauthn_challenges',
          {
            id: {
              type: Sequelize.UUID,
              defaultValue: Sequelize.UUIDV4,
              primaryKey: true,
              allowNull: false,
            },
            challenge: {
              type: Sequelize.STRING(255),
              allowNull: false,
            },
            type: {
              type: Sequelize.ENUM('registration', 'authentication'),
              allowNull: false,
            },
            userId: {
              type: Sequelize.UUID,
              allowNull: true,
              defaultValue: null,
              references: { model: 'users', key: 'id' },
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            expiresAt: {
              type: Sequelize.DATE,
              allowNull: false,
            },
            createdAt: {
              type: Sequelize.DATE,
              allowNull: false,
            },
          },
          { transaction },
        );

        await queryInterface.addIndex('webauthn_challenges', ['challenge'], {
          name: 'webauthn_challenges_challenge',
          unique: true,
          transaction,
        });
        await queryInterface.addIndex('webauthn_challenges', ['expiresAt'], {
          name: 'webauthn_challenges_expires',
          transaction,
        });
        await queryInterface.addIndex('webauthn_challenges', ['userId'], {
          name: 'webauthn_challenges_user_id',
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
      if (names.includes('webauthn_challenges')) {
        await queryInterface.dropTable('webauthn_challenges', { transaction });
      }
      if (names.includes('passkey_credentials')) {
        await queryInterface.dropTable('passkey_credentials', { transaction });
      }
      // MySQL leaves ENUM types hanging when the table is dropped; ignore failures.
      try {
        await queryInterface.sequelize.query(
          "DROP TYPE IF EXISTS `enum_webauthn_challenges_type`;",
          { transaction },
        );
      } catch {
        // ignore
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
