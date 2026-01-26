'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      await queryInterface.changeColumn('artists', 'verificationState', {
        type: Sequelize.ENUM('unverified', 
          'pending', 
          'declined', 
          'mostly declined', 
          'mostly_declined', 
          'mostly allowed', 
          'mostly_allowed', 
          'allowed', 
          'ysmod only',
          'ysmod_only'
        ),
        allowNull: false,
        defaultValue: 'unverified',
      }, { transaction });

      await queryInterface.sequelize.query(`UPDATE artists SET verificationState = 'ysmod_only' WHERE verificationState = 'ysmod only';`, { transaction });
      await queryInterface.sequelize.query(`UPDATE artists SET verificationState = 'mostly_declined' WHERE verificationState = 'mostly declined';`, { transaction });
      await queryInterface.sequelize.query(`UPDATE artists SET verificationState = 'mostly_allowed' WHERE verificationState = 'mostly allowed';`, { transaction });
      
      await queryInterface.changeColumn('artists', 'verificationState', {
        type: Sequelize.ENUM('unverified', 
          'pending', 
          'declined', 
          'mostly_declined', 
          'mostly_allowed', 
          'allowed', 
          'ysmod_only'
        ),
        allowNull: false,
        defaultValue: 'unverified',
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
      await queryInterface.changeColumn('artists', 'verificationState', {
        type: Sequelize.ENUM('unverified', 
          'pending', 
          'declined', 
          'mostly declined', 
          'mostly_declined', 
          'mostly allowed', 
          'mostly_allowed', 
          'allowed', 
          'ysmod only',
          'ysmod_only'
        ),
        allowNull: false,
        defaultValue: 'unverified',
      }, { transaction });

      await queryInterface.sequelize.query(`UPDATE artists SET verificationState = 'ysmod only' WHERE verificationState = 'ysmod_only';`, { transaction });
      await queryInterface.sequelize.query(`UPDATE artists SET verificationState = 'mostly declined' WHERE verificationState = 'mostly_declined';`, { transaction });
      await queryInterface.sequelize.query(`UPDATE artists SET verificationState = 'mostly allowed' WHERE verificationState = 'mostly_allowed';`, { transaction });

      await queryInterface.changeColumn('artists', 'verificationState', {
        type: Sequelize.ENUM('unverified', 
          'pending', 
          'declined', 
          'mostly declined', 
          'mostly allowed', 
          'allowed', 
          'ysmod only',
        ),
        allowNull: false,
        defaultValue: 'unverified',
      }, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
