'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Add extraInfo column to artist_evidences
      await queryInterface.addColumn('level_submission_song_requests', 'verificationState', {
        type: Sequelize.ENUM('declined', 'pending', 'conditional', 'ysmod_only', 'allowed'),
        allowNull: true,
        defaultValue: 'pending',
        after: 'requiresEvidence'
      }, { transaction });

      await queryInterface.removeColumn('level_submission_song_requests', 'requiresEvidence', { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Revert artist_evidences extraInfo
      await queryInterface.removeColumn('level_submission_song_requests', 'verificationState', { transaction });
      await queryInterface.addColumn('level_submission_song_requests', 'requiresEvidence', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        after: 'verificationState'
      }, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
