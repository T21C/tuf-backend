'use strict';

/**
 * Move TUFStellar billing fields off `users` into `user_tuf_stellar_billing` (1:1 by userId).
 * Adds `tufStellarSubscriptionNominalPeriodEndAt` on billing and discrete `user_tuf_stellar_entitlement_segments`.
 * No backfill — columns on users are treated as disposable for this deploy.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.createTable(
        'user_tuf_stellar_billing',
        {
          userId: {
            type: Sequelize.UUID,
            primaryKey: true,
            allowNull: false,
            references: { model: 'users', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          tufStellarSubscriptionExpiresAt: {
            type: Sequelize.DATE,
            allowNull: true,
            defaultValue: null,
          },
          tufStellarSubscriptionExternalId: {
            type: Sequelize.STRING(191),
            allowNull: true,
            defaultValue: null,
          },
          tufStellarSubscriptionPlanExternalId: {
            type: Sequelize.STRING(64),
            allowNull: true,
            defaultValue: null,
          },
          tufStellarSubscriptionCancelledAt: {
            type: Sequelize.DATE,
            allowNull: true,
            defaultValue: null,
          },
          tufStellarBillingLifecycleState: {
            type: Sequelize.STRING(32),
            allowNull: false,
            defaultValue: 'inactive',
          },
          tufStellarPendingAutoRenew: {
            type: Sequelize.BOOLEAN,
            allowNull: true,
            defaultValue: null,
          },
          tufStellarPendingGiftBeneficiaryUserId: {
            type: Sequelize.STRING(36),
            allowNull: true,
            defaultValue: null,
          },
          tufStellarPendingGiftMonths: {
            type: Sequelize.TINYINT.UNSIGNED,
            allowNull: true,
            defaultValue: null,
          },
          tufStellarRecurringPeriodEndAt: {
            type: Sequelize.DATE(6),
            allowNull: true,
            defaultValue: null,
          },
          tufStellarSubscriptionNominalPeriodEndAt: {
            type: Sequelize.DATE(6),
            allowNull: true,
            defaultValue: null,
          },
          tufStellarXsollaBillingSyncAt: {
            type: Sequelize.DATE(6),
            allowNull: true,
            defaultValue: null,
          },
          createdAt: {
            type: Sequelize.DATE,
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
          },
          updatedAt: {
            type: Sequelize.DATE,
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
          },
        },
        { transaction },
      );

      await queryInterface.createTable(
        'user_tuf_stellar_entitlement_segments',
        {
          id: {
            type: Sequelize.BIGINT.UNSIGNED,
            autoIncrement: true,
            primaryKey: true,
            allowNull: false,
          },
          userId: {
            type: Sequelize.UUID,
            allowNull: false,
            references: { model: 'users', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          kind: {
            type: Sequelize.STRING(16),
            allowNull: false,
          },
          months: {
            type: Sequelize.TINYINT.UNSIGNED,
            allowNull: false,
          },
          startsAt: {
            type: Sequelize.DATE(6),
            allowNull: false,
          },
          endsAt: {
            type: Sequelize.DATE(6),
            allowNull: false,
          },
          idempotencyKey: {
            type: Sequelize.STRING(191),
            allowNull: false,
            unique: true,
          },
          xsollaTransactionId: {
            type: Sequelize.BIGINT.UNSIGNED,
            allowNull: true,
            defaultValue: null,
          },
          xsollaSubscriptionId: {
            type: Sequelize.BIGINT.UNSIGNED,
            allowNull: true,
            defaultValue: null,
          },
          billingEventId: {
            type: Sequelize.BIGINT.UNSIGNED,
            allowNull: true,
            defaultValue: null,
            references: { model: 'billing_events', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
          },
          createdAt: {
            type: Sequelize.DATE(6),
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(6)'),
          },
        },
        { transaction },
      );

      await queryInterface.addIndex('user_tuf_stellar_entitlement_segments', ['userId'], {
        name: 'idx_tuf_stellar_entitlement_segments_user',
        transaction,
      });
      await queryInterface.addIndex('user_tuf_stellar_entitlement_segments', ['userId', 'endsAt'], {
        name: 'idx_tuf_stellar_entitlement_segments_user_ends',
        transaction,
      });

      const stellarCols = [
        'tufStellarSubscriptionExpiresAt',
        'tufStellarSubscriptionExternalId',
        'tufStellarSubscriptionPlanExternalId',
        'tufStellarSubscriptionCancelledAt',
        'tufStellarBillingLifecycleState',
        'tufStellarPendingAutoRenew',
        'tufStellarPendingGiftBeneficiaryUserId',
        'tufStellarPendingGiftMonths',
        'tufStellarRecurringPeriodEndAt',
        'tufStellarXsollaBillingSyncAt',
      ];

      for (const col of stellarCols) {
        await queryInterface.removeColumn('users', col, { transaction });
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
      await queryInterface.dropTable('user_tuf_stellar_entitlement_segments', { transaction });
      await queryInterface.dropTable('user_tuf_stellar_billing', { transaction });

      await queryInterface.addColumn(
        'users',
        'tufStellarSubscriptionExpiresAt',
        { type: Sequelize.DATE, allowNull: true, defaultValue: null },
        { transaction },
      );
      await queryInterface.addColumn(
        'users',
        'tufStellarSubscriptionExternalId',
        { type: Sequelize.STRING(191), allowNull: true, defaultValue: null },
        { transaction },
      );
      await queryInterface.addColumn(
        'users',
        'tufStellarSubscriptionPlanExternalId',
        { type: Sequelize.STRING(64), allowNull: true, defaultValue: null },
        { transaction },
      );
      await queryInterface.addColumn(
        'users',
        'tufStellarSubscriptionCancelledAt',
        { type: Sequelize.DATE, allowNull: true, defaultValue: null },
        { transaction },
      );
      await queryInterface.addColumn(
        'users',
        'tufStellarBillingLifecycleState',
        { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'inactive' },
        { transaction },
      );
      await queryInterface.addColumn(
        'users',
        'tufStellarPendingAutoRenew',
        { type: Sequelize.BOOLEAN, allowNull: true, defaultValue: null },
        { transaction },
      );
      await queryInterface.addColumn(
        'users',
        'tufStellarPendingGiftBeneficiaryUserId',
        { type: Sequelize.STRING(36), allowNull: true, defaultValue: null },
        { transaction },
      );
      await queryInterface.addColumn(
        'users',
        'tufStellarPendingGiftMonths',
        { type: Sequelize.TINYINT.UNSIGNED, allowNull: true, defaultValue: null },
        { transaction },
      );
      await queryInterface.addColumn(
        'users',
        'tufStellarRecurringPeriodEndAt',
        { type: Sequelize.DATE(6), allowNull: true, defaultValue: null },
        { transaction },
      );
      await queryInterface.addColumn(
        'users',
        'tufStellarXsollaBillingSyncAt',
        { type: Sequelize.DATE(6), allowNull: true, defaultValue: null },
        { transaction },
      );

      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
  },
};
