'use strict';

/**
 * Private per-viewer notes on player/creator profiles.
 * One row per (user, targetType, targetId); blank text deletes the row.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const tables = await queryInterface.showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));

      if (!names.includes('profile_notes')) {
        await queryInterface.createTable(
          'profile_notes',
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
            targetType: {
              type: Sequelize.ENUM('player', 'creator'),
              allowNull: false,
            },
            targetId: {
              type: Sequelize.INTEGER,
              allowNull: false,
            },
            text: {
              type: Sequelize.STRING(2000),
              allowNull: false,
            },
            createdAt: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
            },
            updatedAt: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
            },
          },
          {transaction},
        );

        await queryInterface.addIndex('profile_notes', ['userId', 'targetType', 'targetId'], {
          name: 'profile_notes_user_id_target_type_target_id',
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
      if (names.includes('profile_notes')) {
        await queryInterface.dropTable('profile_notes', {transaction});
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
