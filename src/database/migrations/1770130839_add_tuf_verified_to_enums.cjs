'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      await queryInterface.changeColumn('artists', 'verificationState', {
        type: Sequelize.ENUM('unverified', 'pending', 'declined', 'mostly_declined', 'mostly_allowed', 'allowed', 'ysmod_only',
          'tuf_verified'
        ),
        
        allowNull: false,
        defaultValue: 'unverified',
      }, { transaction });

      await queryInterface.changeColumn('songs', 'verificationState', {
        type: Sequelize.ENUM('declined', 'pending', 'conditional', 'ysmod_only', 'allowed',
          'tuf_verified'
        ),
        allowNull: false,
        defaultValue: 'pending',
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
        type: Sequelize.ENUM('unverified', 'pending', 'declined', 'mostly_declined', 'mostly_allowed', 'allowed', 'ysmod_only'),
        allowNull: false,
        defaultValue: 'unverified',
      }, { transaction });

      await queryInterface.changeColumn('songs', 'verificationState', {
        type: Sequelize.ENUM('declined', 'pending', 'conditional', 'ysmod_only', 'allowed'),
        allowNull: false,
        defaultValue: 'pending',
      }, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
