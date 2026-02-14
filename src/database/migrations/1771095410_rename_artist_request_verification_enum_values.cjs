'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Expand ENUM to include both old and new names so we can update data
      await queryInterface.changeColumn('level_submission_artist_requests', 'verificationState', {
        type: Sequelize.ENUM(
          'unverified',
          'pending',
          'declined',
          'mostly declined',
          'mostly_declined',
          'mostly allowed',
          'mostly_allowed',
          'allowed'
        ),
        allowNull: true,
        defaultValue: null,
      }, { transaction });

      await queryInterface.sequelize.query(
        `UPDATE level_submission_artist_requests SET verificationState = 'mostly_declined' WHERE verificationState = 'mostly declined';`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `UPDATE level_submission_artist_requests SET verificationState = 'mostly_allowed' WHERE verificationState = 'mostly allowed';`,
        { transaction }
      );

      // Shrink ENUM to only underscore names
      await queryInterface.changeColumn('level_submission_artist_requests', 'verificationState', {
        type: Sequelize.ENUM(
          'unverified',
          'pending',
          'declined',
          'mostly_declined',
          'mostly_allowed',
          'allowed'
        ),
        allowNull: true,
        defaultValue: null,
      }, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Expand ENUM to include both names for rollback
      await queryInterface.changeColumn('level_submission_artist_requests', 'verificationState', {
        type: Sequelize.ENUM(
          'unverified',
          'pending',
          'declined',
          'mostly declined',
          'mostly_declined',
          'mostly allowed',
          'mostly_allowed',
          'allowed'
        ),
        allowNull: true,
        defaultValue: null,
      }, { transaction });

      await queryInterface.sequelize.query(
        `UPDATE level_submission_artist_requests SET verificationState = 'mostly declined' WHERE verificationState = 'mostly_declined';`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `UPDATE level_submission_artist_requests SET verificationState = 'mostly allowed' WHERE verificationState = 'mostly_allowed';`,
        { transaction }
      );

      // Revert to original ENUM with space names
      await queryInterface.changeColumn('level_submission_artist_requests', 'verificationState', {
        type: Sequelize.ENUM(
          'unverified',
          'pending',
          'declined',
          'mostly declined',
          'mostly allowed',
          'allowed'
        ),
        allowNull: true,
        defaultValue: null,
      }, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
