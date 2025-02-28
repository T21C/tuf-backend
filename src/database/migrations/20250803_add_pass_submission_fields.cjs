'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('pass_submissions', 'passerId', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: {
        model: 'players',
        key: 'id'
      },
      after: 'passer'
    });

    await queryInterface.addColumn('pass_submissions', 'passerRequest', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      after: 'passerId'
    });

    await queryInterface.addColumn('pass_submissions', 'submitterUserId', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: {
        model: 'users',
        key: 'id'
      },
      after: 'submitterDiscordPfp'
    });

    await queryInterface.addColumn('pass_submissions', 'assignmentNotes', {
      type: Sequelize.TEXT,
      allowNull: true,
      after: 'submitterUserId'
    });

    // Add indexes for better query performance
    await queryInterface.addIndex('pass_submissions', ['passerId']);
    await queryInterface.addIndex('pass_submissions', ['submitterUserId']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('pass_submissions', ['passerId']);
    await queryInterface.removeIndex('pass_submissions', ['submitterUserId']);
    
    await queryInterface.removeColumn('pass_submissions', 'passerId');
    await queryInterface.removeColumn('pass_submissions', 'passerRequest');
    await queryInterface.removeColumn('pass_submissions', 'submitterUserId');
    await queryInterface.removeColumn('pass_submissions', 'assignmentNotes');
  }
}; 