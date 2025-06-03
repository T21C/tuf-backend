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
      purpose: {
        type: Sequelize.ENUM('PROFILE', 'BANNER', 'THUMBNAIL', 'ASSET', 'DOTADOFAI', 'GENERAL'),
        allowNull: false,
        defaultValue: 'GENERAL',
        comment: 'The intended use of the file (e.g., profile picture, banner)'
      },
      originalName: {
        type: Sequelize.STRING,
        allowNull: true
      },
      filePath: {
        type: Sequelize.STRING,
        allowNull: false
      },
      fileType: {
        type: Sequelize.STRING,
        allowNull: true
      },
      fileSize: {
        type: Sequelize.BIGINT,
        allowNull: false
      },
      mimeType: {
        type: Sequelize.STRING,
        allowNull: true
      },
      accessCount: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      isPublic: {
        type: Sequelize.BOOLEAN,
        defaultValue: true
      },
      metadata: {
        type: Sequelize.JSON,
        allowNull: true,
        comment: 'Additional metadata including image dimensions, variants, etc.'
      },
      parentId: {
        type: Sequelize.UUID,
        allowNull: true,
        references: {
          model: 'cdn_files',
          key: 'id'
        },
        onDelete: 'CASCADE'
      },
      isDirectory: {
        type: Sequelize.BOOLEAN,
        defaultValue: false
      },
      relativePath: {
        type: Sequelize.STRING,
        allowNull: true,
        comment: 'Path relative to the root of the zip file'
      },
      zipFileId: {
        type: Sequelize.UUID,
        allowNull: true,
        references: {
          model: 'cdn_files',
          key: 'id'
        },
        onDelete: 'CASCADE',
        comment: 'Reference to the original zip file if this is an extracted file'
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
    await queryInterface.addIndex('cdn_files', ['fileType']);
    await queryInterface.addIndex('cdn_files', ['createdAt']);
    await queryInterface.addIndex('cdn_files', ['parentId']);
    await queryInterface.addIndex('cdn_files', ['zipFileId']);
    await queryInterface.addIndex('cdn_files', ['isDirectory']);
    await queryInterface.addIndex('cdn_files', ['purpose']);
    await queryInterface.addIndex('file_access_logs', ['fileId']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('file_access_logs');
    await queryInterface.dropTable('cdn_files');
  }
};