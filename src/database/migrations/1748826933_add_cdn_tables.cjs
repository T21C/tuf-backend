'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('cdn_files', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true
      },
      type: {
        type: Sequelize.ENUM('PROFILE', 'BANNER', 'THUMBNAIL', 'LEVELZIP', 'GENERAL'),
        allowNull: false,
        defaultValue: 'GENERAL',
        comment: 'The intended use of the file (e.g., profile picture, banner)'
      },
      filePath: {
        type: Sequelize.STRING,
        allowNull: false
      },
      accessCount: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      metadata: {
        type: Sequelize.JSON,
        allowNull: true
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

    await queryInterface.createTable('file_access_logs', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true
      },
      fileId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'cdn_files',
          key: 'id'
        },
        onDelete: 'CASCADE'
      },
      ipAddress: {
        type: Sequelize.STRING,
        allowNull: false
      },
      userAgent: {
        type: Sequelize.STRING,
        allowNull: true
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

    // Add indexes
    await queryInterface.addIndex('cdn_files', ['type']);
    await queryInterface.addIndex('cdn_files', ['createdAt']);
    await queryInterface.addIndex('file_access_logs', ['fileId']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('file_access_logs');
    await queryInterface.dropTable('cdn_files');
  }
};