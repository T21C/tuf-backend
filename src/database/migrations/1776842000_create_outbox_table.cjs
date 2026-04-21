'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('outbox')) return;

    await queryInterface.createTable('outbox', {
      id: {
        type: Sequelize.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false,
      },
      event_type: {
        type: Sequelize.STRING(128),
        allowNull: false,
      },
      aggregate: {
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      aggregate_id: {
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      payload: {
        type: Sequelize.JSON,
        allowNull: false,
      },
      dedup_key: {
        type: Sequelize.STRING(128),
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE(6),
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(6)'),
      },
      published_at: {
        type: Sequelize.DATE(6),
        allowNull: true,
      },
      attempts: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
      },
    });

    await queryInterface.addIndex('outbox', ['published_at', 'id'], {
      name: 'idx_outbox_unpublished',
    });

    await queryInterface.addConstraint('outbox', {
      fields: ['event_type', 'dedup_key'],
      type: 'unique',
      name: 'uniq_outbox_event_dedup',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('outbox');
  },
};
