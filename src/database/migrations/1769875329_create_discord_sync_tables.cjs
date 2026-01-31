'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Create discord_guilds table
    await queryInterface.createTable('discord_guilds', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true
      },
      guildId: {
        type: Sequelize.STRING(32),
        allowNull: false,
        unique: true
      },
      name: {
        type: Sequelize.STRING(255),
        allowNull: false
      },
      botToken: {
        type: Sequelize.TEXT,
        allowNull: false
      },
      isActive: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
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

    // Add indexes for discord_guilds
    await queryInterface.addIndex('discord_guilds', ['guildId'], { unique: true });
    await queryInterface.addIndex('discord_guilds', ['isActive']);

    // Create discord_sync_roles table
    await queryInterface.createTable('discord_sync_roles', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true
      },
      discordGuildId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'discord_guilds',
          key: 'id'
        },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE'
      },
      roleId: {
        type: Sequelize.STRING(32),
        allowNull: false
      },
      label: {
        type: Sequelize.STRING(255),
        allowNull: false
      },
      type: {
        type: Sequelize.ENUM('DIFFICULTY', 'CURATION'),
        allowNull: false
      },
      minDifficultyId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'difficulties',
          key: 'id'
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE'
      },
      curationTypeId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'curation_types',
          key: 'id'
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE'
      },
      conflictGroup: {
        type: Sequelize.STRING(100),
        allowNull: true
      },
      isActive: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
      },
      sortOrder: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
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

    // Add indexes for discord_sync_roles
    await queryInterface.addIndex('discord_sync_roles', ['discordGuildId']);
    await queryInterface.addIndex('discord_sync_roles', ['type']);
    await queryInterface.addIndex('discord_sync_roles', ['minDifficultyId']);
    await queryInterface.addIndex('discord_sync_roles', ['curationTypeId']);
    await queryInterface.addIndex('discord_sync_roles', ['isActive']);
    await queryInterface.addIndex('discord_sync_roles', ['conflictGroup']);
    await queryInterface.addIndex('discord_sync_roles', ['discordGuildId', 'roleId'], { unique: true });
  },

  async down(queryInterface, Sequelize) {
    // Drop discord_sync_roles first (has FK to discord_guilds)
    await queryInterface.dropTable('discord_sync_roles');
    // Then drop discord_guilds
    await queryInterface.dropTable('discord_guilds');
  }
};
