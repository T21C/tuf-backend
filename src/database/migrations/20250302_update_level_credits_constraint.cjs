'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // First, remove the existing unique constraint
    
    // Add the new unique constraint that includes role
    await queryInterface.addConstraint('level_credits', {
        fields: ['levelId', 'creatorId', 'role'],
        type: 'unique',
        name: 'level_credits_levelId_creatorId_role_unique'
      });
    await queryInterface.removeConstraint(
      'level_credits',
      'level_credits_creatorId_levelId_unique'
    );


  },

  async down(queryInterface, Sequelize) {
    // Remove the new constraint
    await queryInterface.addConstraint('level_credits', {
        fields: ['creatorId', 'levelId'],
        type: 'unique',
        name: 'level_credits_creatorId_levelId_unique'
      });
    await queryInterface.removeConstraint(
      'level_credits',
      'level_credits_levelId_creatorId_role_unique'
    );

    // Add back the old constraint

  }
}; 