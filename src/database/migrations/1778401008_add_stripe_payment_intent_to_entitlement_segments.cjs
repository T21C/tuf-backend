'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (!tables.includes('user_tuf_stellar_entitlement_segments')) return;

    const desc = await queryInterface.describeTable('user_tuf_stellar_entitlement_segments');
    if (desc.stripePaymentIntentId) return;

    await queryInterface.addColumn(
      'user_tuf_stellar_entitlement_segments',
      'stripePaymentIntentId',
      {
        type: Sequelize.STRING(80),
        allowNull: true,
        defaultValue: null,
      },
    );
    await queryInterface.addIndex('user_tuf_stellar_entitlement_segments', ['stripePaymentIntentId'], {
      name: 'idx_tuf_stellar_entitlement_segments_stripe_pi',
    });
  },

  async down(queryInterface) {
    const tables = await queryInterface.showAllTables();
    if (!tables.includes('user_tuf_stellar_entitlement_segments')) return;

    const desc = await queryInterface.describeTable('user_tuf_stellar_entitlement_segments');
    if (!desc.stripePaymentIntentId) return;

    await queryInterface.removeIndex('user_tuf_stellar_entitlement_segments', 'idx_tuf_stellar_entitlement_segments_stripe_pi');
    await queryInterface.removeColumn('user_tuf_stellar_entitlement_segments', 'stripePaymentIntentId');
  },
};
