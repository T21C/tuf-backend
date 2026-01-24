'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Add suffix column to levels table
      await queryInterface.addColumn('levels', 'suffix', {
        type: Sequelize.STRING(255),
        allowNull: true,
        defaultValue: null
      }, { transaction });

      // Add index on suffix for potential queries
      await queryInterface.addIndex('levels', ['suffix'], { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Remove index first
      await queryInterface.removeIndex('levels', ['suffix'], { transaction });

      // Remove column
      await queryInterface.removeColumn('levels', 'suffix', { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
