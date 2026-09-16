'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('passes', 'submissionSource', {
      type: Sequelize.STRING(32),
      allowNull: false,
      defaultValue: 'video',
    });
    await queryInterface.addColumn('passes', 'autoSubmissionRunId', {
      type: Sequelize.UUID,
      allowNull: true,
    });
    await queryInterface.addIndex('passes', ['autoSubmissionRunId'], {
      name: 'passes_auto_submission_run_id_unique',
      unique: true,
    });
    await queryInterface.sequelize.query(
      "UPDATE passes p JOIN auto_submission_receipts r ON r.passId=p.id " +
      "SET p.submissionSource='auto_submission',p.autoSubmissionRunId=r.runId",
    );
  },
  async down(queryInterface) {
    await queryInterface.removeIndex('passes', 'passes_auto_submission_run_id_unique');
    await queryInterface.removeColumn('passes', 'autoSubmissionRunId');
    await queryInterface.removeColumn('passes', 'submissionSource');
  },
};
