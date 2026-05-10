'use strict';

/** Pending Xsolla gift checkout: beneficiary internal user id + term length (months). */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn(
        'users',
        'tufStellarPendingGiftBeneficiaryUserId',
        {
          type: Sequelize.STRING(36),
          allowNull: true,
          defaultValue: null,
        },
        { transaction },
      );
      await queryInterface.addColumn(
        'users',
        'tufStellarPendingGiftMonths',
        {
          type: Sequelize.TINYINT.UNSIGNED,
          allowNull: true,
          defaultValue: null,
        },
        { transaction },
      );
      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.removeColumn('users', 'tufStellarPendingGiftMonths', { transaction });
      await queryInterface.removeColumn('users', 'tufStellarPendingGiftBeneficiaryUserId', { transaction });
      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
  },
};
