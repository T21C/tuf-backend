'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Add extraInfo column to artist_evidences
      await queryInterface.addColumn('artist_evidences', 'extraInfo', {
        type: Sequelize.TEXT,
        allowNull: true,
        after: 'link'
      }, { transaction });

      // Add extraInfo column to song_evidences
      await queryInterface.addColumn('song_evidences', 'extraInfo', {
        type: Sequelize.TEXT,
        allowNull: true,
        after: 'link'
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
      // Revert artist_evidences extraInfo
      await queryInterface.removeColumn('artist_evidences', 'extraInfo', { transaction });
      
      // Revert song_evidences extraInfo
      await queryInterface.removeColumn('song_evidences', 'extraInfo', { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
