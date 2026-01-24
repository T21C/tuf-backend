'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // For artists: Drop and recreate verificationState column with correct ENUM
      await queryInterface.removeColumn('artists', 'verificationState', { transaction });
      
      await queryInterface.addColumn('artists', 'verificationState', {
        type: Sequelize.ENUM('unverified', 'pending', 'declined', 'mostly declined', 'mostly allowed', 'allowed'),
        allowNull: false,
        defaultValue: 'unverified',
        after: 'avatarUrl'
      }, { transaction });

      // For songs: Drop and recreate verificationState column with correct ENUM
      await queryInterface.removeColumn('songs', 'verificationState', { transaction });
      
      await queryInterface.addColumn('songs', 'verificationState', {
        type: Sequelize.ENUM('declined', 'pending', 'conditional', 'ysmod_only', 'allowed'),
        allowNull: false,
        defaultValue: 'pending',
        after: 'name'
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
      // Revert artists verificationState
      await queryInterface.removeColumn('artists', 'verificationState', { transaction });
      
      await queryInterface.addColumn('artists', 'verificationState', {
        type: Sequelize.STRING(255),
        allowNull: false,
        defaultValue: 'unverified',
        after: 'avatarUrl'
      }, { transaction });

      // Revert songs verificationState
      await queryInterface.removeColumn('songs', 'verificationState', { transaction });
      
      await queryInterface.addColumn('songs', 'verificationState', {
        type: Sequelize.STRING(255),
        allowNull: false,
        defaultValue: 'unverified',
        after: 'name'
      }, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
