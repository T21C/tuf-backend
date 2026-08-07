'use strict';

/**
 * OAuth Authorization Server tables: clients, codes, grants, refresh tokens.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const tables = await queryInterface.showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));

      if (!names.includes('oauth_clients')) {
        await queryInterface.createTable(
          'oauth_clients',
          {
            id: {
              type: Sequelize.UUID,
              defaultValue: Sequelize.UUIDV4,
              primaryKey: true,
              allowNull: false,
            },
            clientId: {
              type: Sequelize.STRING(64),
              allowNull: false,
            },
            ownerUserId: {
              type: Sequelize.UUID,
              allowNull: false,
              references: { model: 'users', key: 'id' },
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            name: {
              type: Sequelize.STRING(64),
              allowNull: false,
            },
            description: {
              type: Sequelize.STRING(512),
              allowNull: true,
              defaultValue: null,
            },
            homepageUrl: {
              type: Sequelize.STRING(512),
              allowNull: true,
              defaultValue: null,
            },
            privacyUrl: {
              type: Sequelize.STRING(512),
              allowNull: true,
              defaultValue: null,
            },
            redirectUris: {
              type: Sequelize.JSON,
              allowNull: false,
            },
            allowedScopes: {
              type: Sequelize.STRING(64),
              allowNull: false,
              defaultValue: '0',
            },
            singleGrant: {
              type: Sequelize.BOOLEAN,
              allowNull: false,
              defaultValue: false,
            },
            verified: {
              type: Sequelize.BOOLEAN,
              allowNull: false,
              defaultValue: false,
            },
            status: {
              type: Sequelize.ENUM('active', 'frozen'),
              allowNull: false,
              defaultValue: 'active',
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
        await queryInterface.addIndex('oauth_clients', ['clientId'], {
          name: 'oauth_clients_client_id',
          unique: true,
          transaction,
        });
        await queryInterface.addIndex('oauth_clients', ['ownerUserId'], {
          name: 'oauth_clients_owner_user_id',
          transaction,
        });
      }

      if (!names.includes('oauth_grants')) {
        await queryInterface.createTable(
          'oauth_grants',
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
            clientId: {
              type: Sequelize.STRING(64),
              allowNull: false,
            },
            scopeBits: {
              type: Sequelize.STRING(64),
              allowNull: false,
              defaultValue: '0',
            },
            singleGrant: {
              type: Sequelize.BOOLEAN,
              allowNull: false,
              defaultValue: false,
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
        await queryInterface.addIndex('oauth_grants', ['userId', 'clientId'], {
          name: 'oauth_grants_user_client',
          transaction,
        });
        await queryInterface.addIndex('oauth_grants', ['clientId'], {
          name: 'oauth_grants_client_id',
          transaction,
        });
      }

      if (!names.includes('oauth_authorization_codes')) {
        await queryInterface.createTable(
          'oauth_authorization_codes',
          {
            id: {
              type: Sequelize.UUID,
              defaultValue: Sequelize.UUIDV4,
              primaryKey: true,
              allowNull: false,
            },
            codeHash: {
              type: Sequelize.STRING(64),
              allowNull: false,
            },
            clientId: {
              type: Sequelize.STRING(64),
              allowNull: false,
            },
            userId: {
              type: Sequelize.UUID,
              allowNull: false,
              references: { model: 'users', key: 'id' },
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            grantId: {
              type: Sequelize.UUID,
              allowNull: false,
              references: { model: 'oauth_grants', key: 'id' },
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            redirectUri: {
              type: Sequelize.STRING(1024),
              allowNull: false,
            },
            scopeBits: {
              type: Sequelize.STRING(64),
              allowNull: false,
            },
            codeChallenge: {
              type: Sequelize.STRING(128),
              allowNull: false,
            },
            expiresAt: {
              type: Sequelize.DATE,
              allowNull: false,
            },
            consumedAt: {
              type: Sequelize.DATE,
              allowNull: true,
              defaultValue: null,
            },
            createdAt: {
              type: Sequelize.DATE,
              allowNull: false,
            },
          },
          { transaction },
        );
        await queryInterface.addIndex('oauth_authorization_codes', ['codeHash'], {
          name: 'oauth_authorization_codes_code_hash',
          unique: true,
          transaction,
        });
      }

      if (!names.includes('oauth_refresh_tokens')) {
        await queryInterface.createTable(
          'oauth_refresh_tokens',
          {
            id: {
              type: Sequelize.UUID,
              defaultValue: Sequelize.UUIDV4,
              primaryKey: true,
              allowNull: false,
            },
            grantId: {
              type: Sequelize.UUID,
              allowNull: false,
              references: { model: 'oauth_grants', key: 'id' },
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
              defaultValue: null,
            },
            ip: {
              type: Sequelize.STRING(45),
              allowNull: true,
              defaultValue: null,
            },
            expiresAt: {
              type: Sequelize.DATE,
              allowNull: false,
            },
            replacedBy: {
              type: Sequelize.UUID,
              allowNull: true,
              defaultValue: null,
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
          },
          { transaction },
        );
        await queryInterface.addIndex('oauth_refresh_tokens', ['tokenHash'], {
          name: 'oauth_refresh_tokens_token_hash',
          unique: true,
          transaction,
        });
        await queryInterface.addIndex('oauth_refresh_tokens', ['grantId'], {
          name: 'oauth_refresh_tokens_grant_id',
          transaction,
        });
      }

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.dropTable('oauth_refresh_tokens', { transaction });
      await queryInterface.dropTable('oauth_authorization_codes', { transaction });
      await queryInterface.dropTable('oauth_grants', { transaction });
      await queryInterface.dropTable('oauth_clients', { transaction });
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },
};
