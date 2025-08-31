'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      // First, let's check what constraints exist and remove the old one
      // Remove the old constraint that points to levels table
      await queryInterface.removeConstraint('curation_schedules', 'curation_schedules_ibfk_1');
      console.log('Removed old foreign key constraint curation_schedules_ibfk_1');
    } catch (error) {
      console.log('Old constraint curation_schedules_ibfk_1 not found or already removed:', error.message);
    }

    try {
      // Ensure the correct constraint exists pointing to curations table
      await queryInterface.addConstraint('curation_schedules', {
        fields: ['curationId'],
        type: 'foreign key',
        name: 'fk_curation_schedules_curationId_correct',
        references: {
          table: 'curations',
          field: 'id'
        },
        onDelete: 'CASCADE'
      });
      console.log('Added correct foreign key constraint pointing to curations table');
    } catch (error) {
      console.log('Constraint may already exist:', error.message);
    }
  },

  async down(queryInterface, Sequelize) {
    try {
      // Remove the correct constraint
      await queryInterface.removeConstraint('curation_schedules', 'fk_curation_schedules_curationId_correct');
    } catch (error) {
      console.log('Error removing constraint:', error.message);
    }

    try {
      // Restore the old constraint (for rollback purposes)
      await queryInterface.addConstraint('curation_schedules', {
        fields: ['curationId'],
        type: 'foreign key',
        name: 'curation_schedules_ibfk_1',
        references: {
          table: 'levels',
          field: 'id'
        },
        onDelete: 'CASCADE'
      });
    } catch (error) {
      console.log('Error restoring old constraint:', error.message);
    }
  }
};
