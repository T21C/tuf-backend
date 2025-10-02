'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Add linkCode column
      await queryInterface.addColumn('level_packs', 'linkCode', {
        type: Sequelize.STRING,
        allowNull: true,
        unique: true,
        comment: 'Random alphanumeric code for accessing link-only packs'
      }, { transaction });

      await transaction.commit();
      console.log('Added linkCode column and populated with unique codes for all packs');
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Remove index
      await queryInterface.removeIndex('level_packs', 'level_packs_link_code_idx');

      // Remove column
      await queryInterface.removeColumn('level_packs', 'linkCode', { transaction });

      await transaction.commit();
      console.log('Removed linkCode column and index');
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
