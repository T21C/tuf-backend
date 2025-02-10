'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('players', 'isSubmissionsPaused', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      after: 'isBanned'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('players', 'isSubmissionsPaused');
  }
}; 