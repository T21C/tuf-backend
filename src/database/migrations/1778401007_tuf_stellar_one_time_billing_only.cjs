'use strict';

/**
 * One-time TUFStellar billing only: unify entitlement segment kind to `purchase`;
 * drop recurring/subscription linkage columns from user_tuf_stellar_billing.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(
        `UPDATE user_tuf_stellar_entitlement_segments SET kind = 'purchase' WHERE kind IN ('gift', 'subscription')`,
        { transaction },
      );

      const colsToRemove = [
        'tufStellarSubscriptionExternalId',
        'tufStellarSubscriptionPlanExternalId',
        'tufStellarSubscriptionCancelledAt',
        'tufStellarBillingLifecycleState',
        'tufStellarPendingAutoRenew',
        'tufStellarRecurringPeriodEndAt',
        'tufStellarSubscriptionNominalPeriodEndAt',
        'tufStellarXsollaBillingSyncAt',
      ];

      for (const col of colsToRemove) {
        await queryInterface.removeColumn('user_tuf_stellar_billing', col, { transaction });
      }

      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn(
        'user_tuf_stellar_billing',
        'tufStellarSubscriptionExternalId',
        { type: Sequelize.STRING(191), allowNull: true, defaultValue: null },
        { transaction },
      );
      await queryInterface.addColumn(
        'user_tuf_stellar_billing',
        'tufStellarSubscriptionPlanExternalId',
        { type: Sequelize.STRING(64), allowNull: true, defaultValue: null },
        { transaction },
      );
      await queryInterface.addColumn(
        'user_tuf_stellar_billing',
        'tufStellarSubscriptionCancelledAt',
        { type: Sequelize.DATE, allowNull: true, defaultValue: null },
        { transaction },
      );
      await queryInterface.addColumn(
        'user_tuf_stellar_billing',
        'tufStellarBillingLifecycleState',
        { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'inactive' },
        { transaction },
      );
      await queryInterface.addColumn(
        'user_tuf_stellar_billing',
        'tufStellarPendingAutoRenew',
        { type: Sequelize.BOOLEAN, allowNull: true, defaultValue: null },
        { transaction },
      );
      await queryInterface.addColumn(
        'user_tuf_stellar_billing',
        'tufStellarRecurringPeriodEndAt',
        { type: Sequelize.DATE(6), allowNull: true, defaultValue: null },
        { transaction },
      );
      await queryInterface.addColumn(
        'user_tuf_stellar_billing',
        'tufStellarSubscriptionNominalPeriodEndAt',
        { type: Sequelize.DATE(6), allowNull: true, defaultValue: null },
        { transaction },
      );
      await queryInterface.addColumn(
        'user_tuf_stellar_billing',
        'tufStellarXsollaBillingSyncAt',
        { type: Sequelize.DATE(6), allowNull: true, defaultValue: null },
        { transaction },
      );

      await queryInterface.sequelize.query(
        `UPDATE user_tuf_stellar_entitlement_segments SET kind = 'gift' WHERE kind = 'purchase'`,
        { transaction },
      );

      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
  },
};
