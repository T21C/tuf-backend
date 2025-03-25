'use strict';

const { now } = require('sequelize/lib/utils');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Create announcement_channels table
      await queryInterface.createTable('announcement_channels', {
        id: {
          type: Sequelize.INTEGER,
          primaryKey: true,
          autoIncrement: true,
          allowNull: false,
        },
        label: {
          type: Sequelize.STRING,
          allowNull: false,
        },
        webhookUrl: {
          type: Sequelize.STRING,
          allowNull: false,
        },
        isActive: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: now
        },
        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: now
        },
      }, { transaction });

      // Create announcement_roles table
      await queryInterface.createTable('announcement_roles', {
        id: {
          type: Sequelize.INTEGER,
          primaryKey: true,
          autoIncrement: true,
          allowNull: false,
        },
        roleId: {
          type: Sequelize.STRING,
          allowNull: false,
        },
        label: {
          type: Sequelize.STRING,
          allowNull: false,
        },
        isActive: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: now
        },
        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: now
        },
      }, { transaction });

      // Create announcement_directives table
      await queryInterface.createTable('announcement_directives', {
        id: {
          type: Sequelize.INTEGER,
          primaryKey: true,
          autoIncrement: true,
          allowNull: false,
        },
        difficultyId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: 'difficulties',
            key: 'id',
          },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        name: {
          type: Sequelize.STRING,
          allowNull: false,
        },
        description: {
          type: Sequelize.STRING,
          allowNull: true,
        },
        mode: {
          type: Sequelize.ENUM('STATIC', 'CONDITIONAL'),
          allowNull: false,
          defaultValue: 'STATIC',
        },
        triggerType: {
          type: Sequelize.ENUM('PASS', 'LEVEL'),
          allowNull: false,
          defaultValue: 'PASS',
        },
        condition: {
          type: Sequelize.JSON,
          allowNull: true,
        },
        isActive: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        createdAt: {
          type: Sequelize.DATE,
          allowNull: false, 
          defaultValue: now
        },
        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: now
        },
      }, { transaction });

      // Create directive_actions table
      await queryInterface.createTable('directive_actions', {
        id: {
          type: Sequelize.INTEGER,
          primaryKey: true,
          autoIncrement: true,
          allowNull: false,
        },
        directiveId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: 'announcement_directives',
            key: 'id',
          },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        channelId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: 'announcement_channels',
            key: 'id',
          },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        pingType: {
          type: Sequelize.ENUM('NONE', 'ROLE', 'EVERYONE'),
          allowNull: false,
          defaultValue: 'NONE',
        },
        roleId: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: {
            model: 'announcement_roles',
            key: 'id',
          },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        isActive: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: now
        },
        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: now
        },
      }, { transaction });

      // Add indexes
      await queryInterface.addIndex('announcement_directives', ['difficultyId'], {
        transaction,
      });

      await queryInterface.addIndex('directive_actions', ['directiveId'], {
        transaction,
      });

      await queryInterface.addIndex('directive_actions', ['channelId'], {
        transaction,
      });

      await queryInterface.addIndex('directive_actions', ['roleId'], {
        transaction,
      });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      await queryInterface.dropTable('directive_actions', { transaction });
      await queryInterface.dropTable('announcement_directives', { transaction });
      await queryInterface.dropTable('announcement_roles', { transaction });
      await queryInterface.dropTable('announcement_channels', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
}; 