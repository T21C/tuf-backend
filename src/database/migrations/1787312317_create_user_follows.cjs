'use strict';

/**
 * Player/creator follows for inbox fan-out. Targets are public identities
 * (players.id / creators.id); no cross-pool FKs.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const tables = await queryInterface.showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));

      if (!names.includes('user_follows')) {
        await queryInterface.createTable(
          'user_follows',
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
            createdAt: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
            },
          },
          {transaction},
        );

        await queryInterface.addIndex('user_follows', ['userId', 'targetType', 'targetId'], {
          name: 'user_follows_user_id_target_type_target_id',
          unique: true,
          transaction,
        });
        await queryInterface.addIndex('user_follows', ['targetType', 'targetId'], {
          name: 'user_follows_target_type_target_id',
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
      if (names.includes('user_follows')) {
        await queryInterface.dropTable('user_follows', {transaction});
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
