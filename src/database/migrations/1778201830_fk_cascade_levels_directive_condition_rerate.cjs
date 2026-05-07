'use strict';

/** @type {import('sequelize-cli').Migration} */

/**
 * Align MySQL FK delete rules with app semantics: rows tied to a level should
 * disappear when the level row is hard-deleted (ON DELETE CASCADE).
 *
 * Prior state (from INFORMATION_SCHEMA): NO ACTION on
 * - directive_condition_history.levelId (possibly duplicate constraint names in some DBs)
 * - level_rerate_histories.levelId
 */

async function removeForeignKeyIfExists(queryInterface, tableName, constraintName, transaction) {
  const [rows] = await queryInterface.sequelize.query(
    `
    SELECT CONSTRAINT_NAME
    FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = :tableName
      AND CONSTRAINT_NAME = :constraintName
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
    `,
    { replacements: { tableName, constraintName }, transaction },
  );
  if (Array.isArray(rows) && rows.length > 0) {
    await queryInterface.removeConstraint(tableName, constraintName, { transaction });
  }
}

module.exports = {
  async up(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // directive_condition_history: drop any existing levelId → levels FKs, then single CASCADE
      await removeForeignKeyIfExists(
        queryInterface,
        'directive_condition_history',
        'directive_condition_history_ibfk_2',
        transaction,
      );
      await removeForeignKeyIfExists(
        queryInterface,
        'directive_condition_history',
        'directive_condition_history_ibfk_1',
        transaction,
      );
      await queryInterface.addConstraint('directive_condition_history', {
        fields: ['levelId'],
        type: 'foreign key',
        name: 'directive_condition_history_ibfk_1',
        references: { table: 'levels', field: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        transaction,
      });

      await queryInterface.removeConstraint(
        'level_rerate_histories',
        'level_rerate_histories_ibfk_1',
        { transaction },
      );
      await queryInterface.addConstraint('level_rerate_histories', {
        fields: ['levelId'],
        type: 'foreign key',
        name: 'level_rerate_histories_ibfk_1',
        references: { table: 'levels', field: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        transaction,
      });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.removeConstraint(
        'directive_condition_history',
        'directive_condition_history_ibfk_1',
        { transaction },
      );
      await queryInterface.addConstraint('directive_condition_history', {
        fields: ['levelId'],
        type: 'foreign key',
        name: 'directive_condition_history_ibfk_1',
        references: { table: 'levels', field: 'id' },
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
        transaction,
      });

      await queryInterface.removeConstraint(
        'level_rerate_histories',
        'level_rerate_histories_ibfk_1',
        { transaction },
      );
      await queryInterface.addConstraint('level_rerate_histories', {
        fields: ['levelId'],
        type: 'foreign key',
        name: 'level_rerate_histories_ibfk_1',
        references: { table: 'levels', field: 'id' },
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
        transaction,
      });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
