'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('health_latency_samples')) return;

    await queryInterface.createTable('health_latency_samples', {
      id: {
        type: Sequelize.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false,
      },
      component: {
        type: Sequelize.ENUM('database', 'main_server', 'cdn'),
        allowNull: false,
      },
      recorded_at: {
        type: Sequelize.DATE(6),
        allowNull: false,
      },
      duration_ms: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: true,
      },
      ok: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
      },
    });

    await queryInterface.addIndex('health_latency_samples', ['recorded_at'], {
      name: 'idx_health_latency_recorded_at',
    });

    await queryInterface.addIndex('health_latency_samples', ['component', 'recorded_at'], {
      name: 'idx_health_latency_component_time',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('health_latency_samples');
  },
};
