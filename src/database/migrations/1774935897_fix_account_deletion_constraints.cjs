'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Ensure submissions request tables propagate updates/deletes as modeled
      await queryInterface.removeConstraint(
        'level_submission_creator_requests',
        'level_submission_creator_requests_ibfk_1',
        { transaction },
      );
      await queryInterface.addConstraint('level_submission_creator_requests', {
        fields: ['submissionId'],
        type: 'foreign key',
        name: 'level_submission_creator_requests_ibfk_1',
        references: {
          table: 'level_submissions',
          field: 'id',
        },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        transaction,
      });

      await queryInterface.removeConstraint(
        'level_submission_team_requests',
        'level_submission_team_requests_ibfk_1',
        { transaction },
      );
      await queryInterface.addConstraint('level_submission_team_requests', {
        fields: ['submissionId'],
        type: 'foreign key',
        name: 'level_submission_team_requests_ibfk_1',
        references: {
          table: 'level_submissions',
          field: 'id',
        },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        transaction,
      });

      // User deletion semantics:
      // - creator should persist: unlink (SET NULL)
      await queryInterface.removeConstraint('creators', 'creators_ibfk_1', {
        transaction,
      });
      await queryInterface.addConstraint('creators', {
        fields: ['userId'],
        type: 'foreign key',
        name: 'creators_ibfk_1',
        references: {
          table: 'users',
          field: 'id',
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        transaction,
      });

      // - user-bound content should be deleted (CASCADE)
      await queryInterface.removeConstraint('level_submissions', 'level_submissions_ibfk_4', {
        transaction,
      });
      await queryInterface.addConstraint('level_submissions', {
        fields: ['userId'],
        type: 'foreign key',
        name: 'level_submissions_ibfk_4',
        references: {
          table: 'users',
          field: 'id',
        },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        transaction,
      });

      await queryInterface.removeConstraint('pass_submissions', 'pass_submissions_ibfk_6', {
        transaction,
      });
      await queryInterface.addConstraint('pass_submissions', {
        fields: ['userId'],
        type: 'foreign key',
        name: 'pass_submissions_ibfk_6',
        references: {
          table: 'users',
          field: 'id',
        },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        transaction,
      });

      await queryInterface.removeConstraint('rating_details', 'rating_details_ibfk_4', {
        transaction,
      });
      await queryInterface.addConstraint('rating_details', {
        fields: ['userId'],
        type: 'foreign key',
        name: 'rating_details_ibfk_4',
        references: {
          table: 'users',
          field: 'id',
        },
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
      // Revert to previous DB behavior as captured in constr dump.
      await queryInterface.removeConstraint(
        'level_submission_creator_requests',
        'level_submission_creator_requests_ibfk_1',
        { transaction },
      );
      await queryInterface.addConstraint('level_submission_creator_requests', {
        fields: ['submissionId'],
        type: 'foreign key',
        name: 'level_submission_creator_requests_ibfk_1',
        references: {
          table: 'level_submissions',
          field: 'id',
        },
        onDelete: 'CASCADE',
        onUpdate: 'NO ACTION',
        transaction,
      });

      await queryInterface.removeConstraint(
        'level_submission_team_requests',
        'level_submission_team_requests_ibfk_1',
        { transaction },
      );
      await queryInterface.addConstraint('level_submission_team_requests', {
        fields: ['submissionId'],
        type: 'foreign key',
        name: 'level_submission_team_requests_ibfk_1',
        references: {
          table: 'level_submissions',
          field: 'id',
        },
        onDelete: 'CASCADE',
        onUpdate: 'NO ACTION',
        transaction,
      });

      await queryInterface.removeConstraint('creators', 'creators_ibfk_1', {
        transaction,
      });
      await queryInterface.addConstraint('creators', {
        fields: ['userId'],
        type: 'foreign key',
        name: 'creators_ibfk_1',
        references: {
          table: 'users',
          field: 'id',
        },
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
        transaction,
      });

      await queryInterface.removeConstraint('level_submissions', 'level_submissions_ibfk_4', {
        transaction,
      });
      await queryInterface.addConstraint('level_submissions', {
        fields: ['userId'],
        type: 'foreign key',
        name: 'level_submissions_ibfk_4',
        references: {
          table: 'users',
          field: 'id',
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        transaction,
      });

      await queryInterface.removeConstraint('pass_submissions', 'pass_submissions_ibfk_6', {
        transaction,
      });
      await queryInterface.addConstraint('pass_submissions', {
        fields: ['userId'],
        type: 'foreign key',
        name: 'pass_submissions_ibfk_6',
        references: {
          table: 'users',
          field: 'id',
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        transaction,
      });

      await queryInterface.removeConstraint('rating_details', 'rating_details_ibfk_4', {
        transaction,
      });
      await queryInterface.addConstraint('rating_details', {
        fields: ['userId'],
        type: 'foreign key',
        name: 'rating_details_ibfk_4',
        references: {
          table: 'users',
          field: 'id',
        },
        onDelete: 'NO ACTION',
        onUpdate: 'CASCADE',
        transaction,
      });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};

