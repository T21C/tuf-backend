'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tableExists = await queryInterface.describeTable('refresh_tokens').then(() => true).catch(() => false);
    if (!tableExists) {
      await queryInterface.createTable('refresh_tokens', {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          primaryKey: true,
        },
        userId: {
          type: Sequelize.UUID,
          allowNull: false,
          references: {
            model: 'users',
            key: 'id',
          },
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
        label: {
          type: Sequelize.STRING(255),
          allowNull: true,
        },
        expiresAt: {
          type: Sequelize.DATE,
          allowNull: false,
        },
        revokedAt: {
          type: Sequelize.DATE,
          allowNull: true,
        },
        replacedBy: {
          type: Sequelize.UUID,
          allowNull: true,
          references: {
            model: 'refresh_tokens',
            key: 'id',
          },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
      });
    } else {
      const columns = await queryInterface.describeTable('refresh_tokens');
      if (!columns.label) {
        await queryInterface.addColumn('refresh_tokens', 'label', {
          type: Sequelize.STRING(255),
          allowNull: true,
        });
      }
    }

    const addIndexIfNotExists = async (table, columns, opts) => {
      try {
        await queryInterface.addIndex(table, columns, opts);
      } catch (err) {
        if (err.name !== 'SequelizeDatabaseError' && !/Duplicate key name|already exists/i.test(err.message || '')) {
          throw err;
        }
      }
    };
    await addIndexIfNotExists('refresh_tokens', ['tokenHash', 'revokedAt', 'expiresAt'], {
      name: 'refresh_tokens_token_hash_revoked_expires',
    });
    await addIndexIfNotExists('refresh_tokens', ['userId'], {
      name: 'refresh_tokens_user_id',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('refresh_tokens');
  },
};
