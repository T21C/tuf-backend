'use strict';

/** Recurring period end from Xsolla (`date_next_charge`) + last successful billing sync throttle. */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn(
        'users',
        'tufStellarRecurringPeriodEndAt',
        {
          type: Sequelize.DATE(6),
          allowNull: true,
          defaultValue: null,
        },
        { transaction },
      );
      await queryInterface.addColumn(
        'users',
        'tufStellarXsollaBillingSyncAt',
        {
          type: Sequelize.DATE(6),
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
      await queryInterface.removeColumn('users', 'tufStellarXsollaBillingSyncAt', { transaction });
      await queryInterface.removeColumn('users', 'tufStellarRecurringPeriodEndAt', { transaction });
      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
  },
};
