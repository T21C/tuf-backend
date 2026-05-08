'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('billing_events')) return;

    await queryInterface.createTable('billing_events', {
      id: {
        type: Sequelize.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false,
      },
      provider: {
        type: Sequelize.STRING(32),
        allowNull: false,
      },
      event_type: {
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      idempotency_key: {
        type: Sequelize.STRING(191),
        allowNull: false,
      },
      status: {
        type: Sequelize.ENUM('received', 'processed', 'ignored', 'failed'),
        allowNull: false,
        defaultValue: 'received',
      },
      user_id: {
        type: Sequelize.STRING(64),
        allowNull: true,
      },
      xsolla_transaction_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
      },
      xsolla_subscription_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
      },
      external_id: {
        type: Sequelize.STRING(128),
        allowNull: true,
      },
      raw_body: {
        type: Sequelize.TEXT('medium'),
        allowNull: false,
      },
      raw_body_sha256: {
        type: Sequelize.STRING(64),
        allowNull: true,
      },
      error_code: {
        type: Sequelize.STRING(64),
        allowNull: true,
      },
      error_message: {
        type: Sequelize.STRING(512),
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE(6),
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(6)'),
      },
      processed_at: {
        type: Sequelize.DATE(6),
        allowNull: true,
      },
      failed_at: {
        type: Sequelize.DATE(6),
        allowNull: true,
      },
    });

    await queryInterface.addIndex('billing_events', ['provider', 'idempotency_key'], {
      unique: true,
      name: 'uniq_billing_events_provider_idempotency',
    });
    await queryInterface.addIndex('billing_events', ['user_id', 'created_at'], {
      name: 'idx_billing_events_user_created_at',
    });
    await queryInterface.addIndex('billing_events', ['xsolla_subscription_id', 'created_at'], {
      name: 'idx_billing_events_xsolla_subscription_created_at',
    });
    await queryInterface.addIndex('billing_events', ['xsolla_transaction_id', 'created_at'], {
      name: 'idx_billing_events_xsolla_transaction_created_at',
    });
    await queryInterface.addIndex('billing_events', ['status', 'created_at', 'id'], {
      name: 'idx_billing_events_status_created_at',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('billing_events');
  },
};

