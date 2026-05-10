'use strict';

/** Gift beneficiary UUID for activity queries (purchaser remains user_id). */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn(
        'billing_events',
        'beneficiary_user_id',
        {
          type: Sequelize.STRING(36),
          allowNull: true,
          defaultValue: null,
        },
        { transaction },
      );
      await queryInterface.addIndex('billing_events', ['beneficiary_user_id', 'created_at'], {
        name: 'idx_billing_events_beneficiary_created_at',
        transaction,
      });
      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.removeIndex('billing_events', 'idx_billing_events_beneficiary_created_at', {
        transaction,
      });
      await queryInterface.removeColumn('billing_events', 'beneficiary_user_id', { transaction });
      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
  },
};
