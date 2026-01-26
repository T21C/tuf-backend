'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      await queryInterface.changeColumn('artists', 'verificationState', {
        type: Sequelize.ENUM('unverified', 'pending', 'declined', 'mostly declined', 'mostly allowed', 'allowed', 'ysmod only'),
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
      // Revert artists verificationState
      await queryInterface.changeColumn('artists', 'verificationState', {
        type: Sequelize.ENUM('unverified', 'pending', 'declined', 'mostly declined', 'mostly allowed', 'allowed'),
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
