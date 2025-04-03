'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // First, remove the unique constraint from the levelId index
    await queryInterface.removeConstraint('ratings', 'ratings_ibfk_1');
    await queryInterface.removeIndex('ratings', 'ratings_level_id');
    
    // Then add a non-unique index for faster queries
    await queryInterface.addIndex('ratings', ['levelId'], {
      name: 'ratings_level_id_idx'
    });
    await queryInterface.addConstraint('ratings', {
      fields: ['levelId'],
      type: 'foreign key',
      name: 'ratings_ibfk_1',
      references: {
        table: 'levels',
        field: 'id'
      }
    });
  },

  async down(queryInterface, Sequelize) {
    // Remove the non-unique index
    await queryInterface.removeIndex('ratings', 'ratings_level_id_idx');
    
    // Re-add the unique constraint
    await queryInterface.addIndex('ratings', ['levelId'], {
      name: 'ratings_level_id',
      unique: true
    });
  }
}; 