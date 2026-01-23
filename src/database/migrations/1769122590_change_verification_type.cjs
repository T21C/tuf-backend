'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Create artists table
      await queryInterface.changeColumn('artists', 'verificationState', {
        type: Sequelize.STRING(255),
        allowNull: false,
        defaultValue: 'unverified'
      }, { transaction });

      // Create artistEvidences table
      await queryInterface.changeColumn('artist_evidences', 'type', {
        type: Sequelize.STRING(255),
        allowNull: false,
        defaultValue: 'other'
      }, { transaction });

      // Create songs table
      await queryInterface.changeColumn('songs', 'verificationState', {
        type: Sequelize.STRING(255),
        allowNull: false,
        defaultValue: 'unverified'
      }, { transaction });

      // Create songEvidences table
      await queryInterface.changeColumn('song_evidences', 'type', {
        type: Sequelize.STRING(255),
        allowNull: false,
        defaultValue: 'other'
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
    

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
