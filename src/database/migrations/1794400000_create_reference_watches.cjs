'use strict';

/**
 * Per-user PGU difficulty watches for reference-change inbox fan-out.
 * difficultyId is a plain integer (no cross-pool FK to difficulties).
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const tables = await queryInterface.showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));

      if (!names.includes('reference_watches')) {
        await queryInterface.createTable(
          'reference_watches',
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
            difficultyId: {
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

        await queryInterface.addIndex('reference_watches', ['userId', 'difficultyId'], {
          name: 'reference_watches_user_id_difficulty_id',
          unique: true,
          transaction,
        });
        await queryInterface.addIndex('reference_watches', ['difficultyId'], {
          name: 'reference_watches_difficulty_id',
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
      if (names.includes('reference_watches')) {
        await queryInterface.dropTable('reference_watches', {transaction});
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
