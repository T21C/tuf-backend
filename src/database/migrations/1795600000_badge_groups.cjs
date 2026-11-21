'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const tables = await queryInterface.showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));

      if (!names.includes('badge_groups')) {
        await queryInterface.createTable(
          'badge_groups',
          {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            name: { type: Sequelize.STRING(80), allowNull: false },
            sortOrder: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
            createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
            updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
          },
          { transaction },
        );
        await queryInterface.addIndex('badge_groups', ['name'], {
          unique: true,
          name: 'badge_groups_name_unique',
          transaction,
        });
        await queryInterface.addIndex('badge_groups', ['sortOrder'], {
          name: 'badge_groups_sort_order',
          transaction,
        });
      }

      if (names.includes('badge_definitions')) {
        const table = await queryInterface.describeTable('badge_definitions');
        if (!table.groupId) {
          await queryInterface.addColumn(
            'badge_definitions',
            'groupId',
            { type: Sequelize.INTEGER, allowNull: true, defaultValue: null },
            { transaction },
          );
          await queryInterface.addIndex('badge_definitions', ['groupId'], {
            name: 'badge_definitions_groupId',
            transaction,
          });
          await queryInterface.addConstraint('badge_definitions', {
            fields: ['groupId'],
            type: 'foreign key',
            name: 'badge_definitions_groupId_badge_groups_fk',
            references: { table: 'badge_groups', field: 'id' },
            onDelete: 'SET NULL',
            onUpdate: 'CASCADE',
            transaction,
          });
        }
        if (!table.sortOrder) {
          await queryInterface.addColumn(
            'badge_definitions',
            'sortOrder',
            { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
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

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const tables = await queryInterface.showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));

      if (names.includes('badge_definitions')) {
        const table = await queryInterface.describeTable('badge_definitions');
        if (table.groupId) {
          await queryInterface.removeConstraint(
            'badge_definitions',
            'badge_definitions_groupId_badge_groups_fk',
            { transaction },
          );
          await queryInterface.removeColumn('badge_definitions', 'groupId', { transaction });
        }
        if (table.sortOrder) {
          await queryInterface.removeColumn('badge_definitions', 'sortOrder', { transaction });
        }
      }

      if (names.includes('badge_groups')) {
        await queryInterface.dropTable('badge_groups', { transaction });
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
