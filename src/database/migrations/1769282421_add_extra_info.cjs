'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // For artists: Add extraInfo column
      await queryInterface.addColumn('artists', 'extraInfo', {
        type: Sequelize.TEXT,
        allowNull: true,
        after: 'verificationState'
      }, { transaction });

      // For songs: Add extraInfo column
      await queryInterface.addColumn('songs', 'extraInfo', {
        type: Sequelize.TEXT,
        allowNull: true,
        after: 'verificationState'
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
      // Revert artists extraInfo
      await queryInterface.removeColumn('artists', 'extraInfo', { transaction });
      
      // Revert songs extraInfo
      await queryInterface.removeColumn('songs', 'extraInfo', { transaction });
      

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
