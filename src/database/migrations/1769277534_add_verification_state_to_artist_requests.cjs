'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Add verificationState column to level_submission_artist_requests table
      await queryInterface.addColumn('level_submission_artist_requests', 'verificationState', {
        type: Sequelize.ENUM('unverified', 'pending', 'declined', 'mostly declined', 'mostly allowed', 'allowed'),
        allowNull: true,
        defaultValue: null,
        after: 'requiresEvidence'
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
      // Remove verificationState column
      await queryInterface.removeColumn('level_submission_artist_requests', 'verificationState', { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
