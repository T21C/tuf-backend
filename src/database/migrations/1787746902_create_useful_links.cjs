'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const tables = await queryInterface.showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));

      if (!names.includes('useful_links')) {
        await queryInterface.createTable(
          'useful_links',
          {
            id: {
              type: Sequelize.INTEGER,
              autoIncrement: true,
              primaryKey: true,
              allowNull: false,
            },
            title: {
              type: Sequelize.STRING(255),
              allowNull: false,
            },
            url: {
              type: Sequelize.TEXT,
              allowNull: false,
            },
            description: {
              type: Sequelize.TEXT,
              allowNull: true,
            },
            category: {
              type: Sequelize.STRING(64),
              allowNull: true,
            },
            sortWeight: {
              type: Sequelize.INTEGER,
              allowNull: false,
              defaultValue: 0,
            },
            isPublished: {
              type: Sequelize.BOOLEAN,
              allowNull: false,
              defaultValue: true,
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

        await queryInterface.addIndex('useful_links', ['sortWeight'], {
          name: 'idx_useful_links_sort_weight',
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
      if (names.includes('useful_links')) {
        await queryInterface.dropTable('useful_links', {transaction});
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
