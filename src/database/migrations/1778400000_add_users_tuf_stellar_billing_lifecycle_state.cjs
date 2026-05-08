'use strict';

/** Persisted billing lifecycle state (`billingLifecycleTransition.ts`). Backfilled from subscription facts. */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn(
        'users',
        'tufStellarBillingLifecycleState',
        {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'inactive',
        },
        { transaction },
      );

      await queryInterface.sequelize.query(
        `
        UPDATE users
        SET tufStellarBillingLifecycleState = CASE
          WHEN tufStellarSubscriptionExpiresAt IS NULL OR tufStellarSubscriptionExpiresAt <= UTC_TIMESTAMP() THEN 'inactive'
          WHEN tufStellarSubscriptionCancelledAt IS NOT NULL THEN 'active_cancelling'
          WHEN tufStellarSubscriptionExternalId LIKE 'tx:%' THEN 'active_checkout_pending'
          ELSE 'active_renewing'
        END
        `,
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
      await queryInterface.removeColumn('users', 'tufStellarBillingLifecycleState', { transaction });
      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
  },
};
