'use strict';

/**
 * Per-scope emailed step-up confirmation codes.
 * Kept off the users row so a pending email-verify code and a step-up code
 * can coexist, and so attempt counting is per-code.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const tables = await queryInterface.showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));
      if (!names.includes('step_up_codes')) {
        await queryInterface.createTable(
          'step_up_codes',
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
            scope: {
              type: Sequelize.STRING(32),
              allowNull: false,
            },
            codeHash: {
              type: Sequelize.STRING(64),
              allowNull: false,
            },
            expiresAt: {
              type: Sequelize.DATE,
              allowNull: false,
            },
            attempts: {
              type: Sequelize.INTEGER,
              allowNull: false,
              defaultValue: 0,
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
            updatedAt: {
              type: Sequelize.DATE,
              allowNull: false,
            },
          },
          { transaction },
        );

        await queryInterface.addIndex('step_up_codes', ['userId', 'scope'], {
          name: 'step_up_codes_user_scope',
          transaction,
        });
        await queryInterface.addIndex('step_up_codes', ['expiresAt'], {
          name: 'step_up_codes_expires',
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
      if (names.includes('step_up_codes')) {
        await queryInterface.dropTable('step_up_codes', { transaction });
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
