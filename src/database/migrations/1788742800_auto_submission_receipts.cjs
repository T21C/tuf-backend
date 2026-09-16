'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('auto_submission_receipts', {
      runId: {type: Sequelize.UUID, primaryKey: true, allowNull: false},
      ownerId: {type: Sequelize.UUID, allowNull: false},
      passId: {type: Sequelize.INTEGER, allowNull: false, unique: true},
      requestHash: {type: Sequelize.STRING(64), allowNull: false},
      validation: {type: Sequelize.JSON, allowNull: false},
      createdAt: {type: Sequelize.DATE, allowNull: false},
      updatedAt: {type: Sequelize.DATE, allowNull: false},
    });
    await queryInterface.addIndex('auto_submission_receipts', ['ownerId', 'createdAt']);
  },
  async down(queryInterface) { await queryInterface.dropTable('auto_submission_receipts'); },
};
