'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const desc = await queryInterface.describeTable('billing_events');
    if (!desc.status) return;

    await queryInterface.changeColumn('billing_events', 'status', {
      type: Sequelize.ENUM('received', 'processed', 'ignored', 'failed', 'refunded'),
      allowNull: false,
      defaultValue: 'received',
    });
  },

  async down(queryInterface, Sequelize) {
    const desc = await queryInterface.describeTable('billing_events');
    if (!desc.status) return;

    await queryInterface.sequelize.query(
      `UPDATE billing_events SET status = 'processed' WHERE status = 'refunded'`,
    );

    await queryInterface.changeColumn('billing_events', 'status', {
      type: Sequelize.ENUM('received', 'processed', 'ignored', 'failed'),
      allowNull: false,
      defaultValue: 'received',
    });
  },
};
