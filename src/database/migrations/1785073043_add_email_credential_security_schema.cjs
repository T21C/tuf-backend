'use strict';

/**
 * Email credential security schema:
 * - users.pendingEmail + purpose-split SHA-256 token columns
 * - profile_action_logs
 * - widen rate_limits.ip for ip:/user: subject keys
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const users = await queryInterface.describeTable('users');

      if (!users.pendingEmail) {
        await queryInterface.addColumn(
          'users',
          'pendingEmail',
          {
            type: Sequelize.STRING,
            allowNull: true,
            defaultValue: null,
          },
          { transaction },
        );
      }

      if (!users.emailVerifyTokenHash) {
        await queryInterface.addColumn(
          'users',
          'emailVerifyTokenHash',
          {
            type: Sequelize.STRING(64),
            allowNull: true,
            defaultValue: null,
          },
          { transaction },
        );
      }

      if (!users.emailVerifyExpires) {
        await queryInterface.addColumn(
          'users',
          'emailVerifyExpires',
          {
            type: Sequelize.DATE,
            allowNull: true,
            defaultValue: null,
          },
          { transaction },
        );
      }

      if (!users.passwordResetTokenHash) {
        await queryInterface.addColumn(
          'users',
          'passwordResetTokenHash',
          {
            type: Sequelize.STRING(64),
            allowNull: true,
            defaultValue: null,
          },
          { transaction },
        );
      }

      // Unique index on pendingEmail (multiple NULLs allowed in MySQL)
      const userIndexes = await queryInterface.showIndex('users');
      const hasPendingEmailUnique = userIndexes.some(
        (idx) =>
          idx.name === 'users_pending_email_unique' ||
          idx.name === 'pendingEmail_unique' ||
          (idx.unique &&
            Array.isArray(idx.fields) &&
            idx.fields.length === 1 &&
            (idx.fields[0].attribute === 'pendingEmail' ||
              idx.fields[0].name === 'pendingEmail' ||
              idx.fields[0] === 'pendingEmail')),
      );
      if (!hasPendingEmailUnique) {
        await queryInterface.addIndex('users', ['pendingEmail'], {
          unique: true,
          name: 'users_pending_email_unique',
          transaction,
        });
      }

      const tables = await queryInterface.showAllTables();
      const tableNames = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));
      if (!tableNames.includes('profile_action_logs')) {
        await queryInterface.createTable(
          'profile_action_logs',
          {
            id: {
              type: Sequelize.INTEGER,
              autoIncrement: true,
              primaryKey: true,
            },
            userId: {
              type: Sequelize.UUID,
              allowNull: false,
              references: { model: 'users', key: 'id' },
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            action: {
              type: Sequelize.STRING(64),
              allowNull: false,
            },
            metadata: {
              type: Sequelize.JSON,
              allowNull: true,
              defaultValue: null,
            },
            ip: {
              type: Sequelize.STRING(80),
              allowNull: true,
              defaultValue: null,
            },
            userAgent: {
              type: Sequelize.STRING(512),
              allowNull: true,
              defaultValue: null,
            },
            createdAt: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
            },
            updatedAt: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'),
            },
          },
          { transaction },
        );

        await queryInterface.addIndex('profile_action_logs', ['userId', 'createdAt'], {
          name: 'profile_action_logs_user_created',
          transaction,
        });
        await queryInterface.addIndex('profile_action_logs', ['action'], {
          name: 'profile_action_logs_action',
          transaction,
        });
      }

      if (tableNames.includes('rate_limits')) {
        const rateLimits = await queryInterface.describeTable('rate_limits');
        const ipType = rateLimits.ip?.type || '';
        // Widen from VARCHAR(45) so subject keys like user:<uuid> fit
        if (/varchar\(45\)/i.test(ipType) || /string\(45\)/i.test(ipType)) {
          await queryInterface.changeColumn(
            'rate_limits',
            'ip',
            {
              type: Sequelize.STRING(80),
              allowNull: false,
              comment: 'Client IP or rate-limit subject key (ip:… / user:…)',
            },
            { transaction },
          );
        }
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const tables = await queryInterface.showAllTables();
      const tableNames = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));

      if (tableNames.includes('profile_action_logs')) {
        await queryInterface.dropTable('profile_action_logs', { transaction });
      }

      if (tableNames.includes('rate_limits')) {
        await queryInterface.changeColumn(
          'rate_limits',
          'ip',
          {
            type: Sequelize.STRING(45),
            allowNull: false,
            comment: 'IPv4 or IPv6 address',
          },
          { transaction },
        );
      }

      const users = await queryInterface.describeTable('users');
      const userIndexes = await queryInterface.showIndex('users');
      if (userIndexes.some((idx) => idx.name === 'users_pending_email_unique')) {
        await queryInterface.removeIndex('users', 'users_pending_email_unique', { transaction });
      }

      for (const col of [
        'passwordResetTokenHash',
        'emailVerifyExpires',
        'emailVerifyTokenHash',
        'pendingEmail',
      ]) {
        if (users[col]) {
          await queryInterface.removeColumn('users', col, { transaction });
        }
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
