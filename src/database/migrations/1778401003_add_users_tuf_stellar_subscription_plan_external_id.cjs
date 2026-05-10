'use strict';

/** Xsolla recurring `plan_id` for the user's active subscription (display ➔ term months via catalog). */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn(
        'users',
        'tufStellarSubscriptionPlanExternalId',
        {
          type: Sequelize.STRING(64),
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
      await queryInterface.removeColumn('users', 'tufStellarSubscriptionPlanExternalId', { transaction });
      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
  },
};
