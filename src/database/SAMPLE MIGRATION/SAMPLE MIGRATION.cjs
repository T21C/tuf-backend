'use strict';

// NAMING CONVENTION:
// tables: table_name
// columns: columnName

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Example: Add a new column to the levels table
      await queryInterface.addColumn('levels', 'sampleField', {
        type: Sequelize.STRING,
        allowNull: true,
        after: 'id' // MySQL specific, places column after 'id'
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
      // Revert the changes
      await queryInterface.removeColumn('levels', 'sampleField', { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
}; 