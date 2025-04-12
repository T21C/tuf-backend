'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('rate_limits', {
      id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        autoIncrement: true,
        primaryKey: true
      },
      ip: {
        type: Sequelize.STRING(45),
        allowNull: false,
        comment: 'IPv4 or IPv6 address'
      },
      type: {
        type: Sequelize.STRING(50),
        allowNull: false,
        comment: 'Type of rate limit (e.g., registration, login)'
      },
      attempts: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: 'Number of attempts made'
      },
      blocked: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'Whether this IP is blocked'
      },
      blockedUntil: {
        type: Sequelize.DATE,
        allowNull: true,
        comment: 'When the block expires'
      },
      windowStart: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        comment: 'Start of the current rate limit window'
      },
      windowEnd: {
        type: Sequelize.DATE,
        allowNull: false,
        comment: 'End of the current rate limit window'
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      }
    });

    // Add indexes for faster lookups - but NOT unique
    await queryInterface.addIndex('rate_limits', ['ip', 'type'], {
      name: 'rate_limits_ip_type_idx'
    });
    
    await queryInterface.addIndex('rate_limits', ['blocked', 'blockedUntil'], {
      name: 'rate_limits_blocked_idx'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('rate_limits');
  }
}; 