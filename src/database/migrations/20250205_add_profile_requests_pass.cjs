'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const columns = await queryInterface.describeTable('pass_submissions');
    
    // Add passerRequest if it doesn't exist
    if (!columns.passerRequest) {
      await queryInterface.addColumn('pass_submissions', 'passerRequest', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        after: 'assignedPlayerId'
      });
    }
  },

  async down(queryInterface, Sequelize) {
    // Remove passerRequest column
    await queryInterface.removeColumn('pass_submissions', 'passerRequest');
  }
}; 