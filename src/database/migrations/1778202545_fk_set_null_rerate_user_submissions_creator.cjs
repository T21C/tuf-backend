'use strict';

/** @type {import('sequelize-cli').Migration} */

/**
 * FK hardening: allow creator / team / user cleanup without blocking deletes.
 * Constraint names match typical InnoDB naming from schema dumps (verify on clone before prod).
 */

async function removeFkIfExists(queryInterface, table, name, transaction) {
  const [rows] = await queryInterface.sequelize.query(
    `
    SELECT CONSTRAINT_NAME
    FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = :table
      AND CONSTRAINT_NAME = :name
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
    `,
    { replacements: { table, name }, transaction },
  );
  if (Array.isArray(rows) && rows.length > 0) {
    await queryInterface.removeConstraint(table, name, { transaction });
  }
}

module.exports = {
  async up(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await removeFkIfExists(queryInterface, 'level_rerate_histories', 'level_rerate_histories_ibfk_4', transaction);
      await queryInterface.addConstraint('level_rerate_histories', {
        fields: ['reratedBy'],
        type: 'foreign key',
        name: 'level_rerate_histories_ibfk_4',
        references: { table: 'users', field: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        transaction,
      });

      await queryInterface.removeConstraint('level_submissions', 'level_submissions_ibfk_1', { transaction });
      await queryInterface.addConstraint('level_submissions', {
        fields: ['charterId'],
        type: 'foreign key',
        name: 'level_submissions_ibfk_1',
        references: { table: 'creators', field: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        transaction,
      });

      await queryInterface.removeConstraint('level_submissions', 'level_submissions_ibfk_2', { transaction });
      await queryInterface.addConstraint('level_submissions', {
        fields: ['teamId'],
        type: 'foreign key',
        name: 'level_submissions_ibfk_2',
        references: { table: 'teams', field: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        transaction,
      });

      await queryInterface.removeConstraint('level_submissions', 'level_submissions_ibfk_3', { transaction });
      await queryInterface.addConstraint('level_submissions', {
        fields: ['vfxerId'],
        type: 'foreign key',
        name: 'level_submissions_ibfk_3',
        references: { table: 'creators', field: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        transaction,
      });

      await removeFkIfExists(
        queryInterface,
        'level_submission_creator_requests',
        'level_submission_creator_requests_ibfk_2',
        transaction,
      );
      await queryInterface.addConstraint('level_submission_creator_requests', {
        fields: ['creatorId'],
        type: 'foreign key',
        name: 'level_submission_creator_requests_ibfk_2',
        references: { table: 'creators', field: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        transaction,
      });

      await removeFkIfExists(
        queryInterface,
        'level_submission_team_requests',
        'level_submission_team_requests_ibfk_2',
        transaction,
      );
      await queryInterface.addConstraint('level_submission_team_requests', {
        fields: ['teamId'],
        type: 'foreign key',
        name: 'level_submission_team_requests_ibfk_2',
        references: { table: 'teams', field: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        transaction,
      });

      await queryInterface.removeConstraint('users', 'users_ibfk_2', { transaction });
      await queryInterface.addConstraint('users', {
        fields: ['creatorId'],
        type: 'foreign key',
        name: 'users_ibfk_2',
        references: { table: 'creators', field: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        transaction,
      });

      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.removeConstraint('users', 'users_ibfk_2', { transaction });
      await queryInterface.addConstraint('users', {
        fields: ['creatorId'],
        type: 'foreign key',
        name: 'users_ibfk_2',
        references: { table: 'creators', field: 'id' },
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
        transaction,
      });

      await queryInterface.removeConstraint(
        'level_submission_team_requests',
        'level_submission_team_requests_ibfk_2',
        { transaction },
      );
      await queryInterface.addConstraint('level_submission_team_requests', {
        fields: ['teamId'],
        type: 'foreign key',
        name: 'level_submission_team_requests_ibfk_2',
        references: { table: 'teams', field: 'id' },
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
        transaction,
      });

      await queryInterface.removeConstraint(
        'level_submission_creator_requests',
        'level_submission_creator_requests_ibfk_2',
        { transaction },
      );
      await queryInterface.addConstraint('level_submission_creator_requests', {
        fields: ['creatorId'],
        type: 'foreign key',
        name: 'level_submission_creator_requests_ibfk_2',
        references: { table: 'creators', field: 'id' },
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
        transaction,
      });

      await queryInterface.removeConstraint('level_submissions', 'level_submissions_ibfk_3', { transaction });
      await queryInterface.addConstraint('level_submissions', {
        fields: ['vfxerId'],
        type: 'foreign key',
        name: 'level_submissions_ibfk_3',
        references: { table: 'creators', field: 'id' },
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
        transaction,
      });

      await queryInterface.removeConstraint('level_submissions', 'level_submissions_ibfk_2', { transaction });
      await queryInterface.addConstraint('level_submissions', {
        fields: ['teamId'],
        type: 'foreign key',
        name: 'level_submissions_ibfk_2',
        references: { table: 'teams', field: 'id' },
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
        transaction,
      });

      await queryInterface.removeConstraint('level_submissions', 'level_submissions_ibfk_1', { transaction });
      await queryInterface.addConstraint('level_submissions', {
        fields: ['charterId'],
        type: 'foreign key',
        name: 'level_submissions_ibfk_1',
        references: { table: 'creators', field: 'id' },
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
        transaction,
      });

      await queryInterface.removeConstraint('level_rerate_histories', 'level_rerate_histories_ibfk_4', {
        transaction,
      });
      await queryInterface.addConstraint('level_rerate_histories', {
        fields: ['reratedBy'],
        type: 'foreign key',
        name: 'level_rerate_histories_ibfk_4',
        references: { table: 'users', field: 'id' },
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
        transaction,
      });

      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
  },
};
