'use strict';

/**
 * Per-level history of curation type set changes.
 * Empty arrays mean the level had no curation types on that side of the change.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const tables = await queryInterface.showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));

      if (!names.includes('level_curation_histories')) {
        await queryInterface.createTable(
          'level_curation_histories',
          {
            id: {
              type: Sequelize.INTEGER,
              autoIncrement: true,
              primaryKey: true,
              allowNull: false,
            },
            levelId: {
              type: Sequelize.INTEGER,
              allowNull: false,
              references: { model: 'levels', key: 'id' },
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            previousTypeIds: {
              type: Sequelize.JSON,
              allowNull: false,
            },
            newTypeIds: {
              type: Sequelize.JSON,
              allowNull: false,
            },
            changedBy: {
              type: Sequelize.UUID,
              allowNull: true,
              references: { model: 'users', key: 'id' },
              onUpdate: 'CASCADE',
              onDelete: 'SET NULL',
            },
            createdAt: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
            },
          },
          { transaction },
        );

        await queryInterface.addIndex('level_curation_histories', ['levelId', 'createdAt'], {
          name: 'idx_level_curation_histories_level_created',
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
      await queryInterface.dropTable('level_curation_histories', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
