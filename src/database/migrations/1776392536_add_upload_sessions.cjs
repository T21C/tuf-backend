'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('upload_sessions', {
      id: {
        type: Sequelize.CHAR(36),
        primaryKey: true,
        allowNull: false,
      },
      kind: {
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      userId: {
        type: Sequelize.UUID,
        allowNull: true,
        defaultValue: null,
      },
      originalName: {
        type: 'VARCHAR(512) CHARACTER SET utf8mb4',
        allowNull: false,
      },
      mimeType: {
        type: Sequelize.STRING(128),
        allowNull: true,
        defaultValue: null,
      },
      declaredSize: {
        type: Sequelize.BIGINT,
        allowNull: false,
      },
      declaredHash: {
        type: Sequelize.CHAR(64),
        allowNull: false,
      },
      chunkSize: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      totalChunks: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      receivedChunks: {
        type: Sequelize.JSON,
        allowNull: false,
      },
      status: {
        type: Sequelize.ENUM('uploading', 'assembling', 'assembled', 'failed', 'cancelled'),
        allowNull: false,
        defaultValue: 'uploading',
      },
      assembledPath: {
        type: Sequelize.STRING(1024),
        allowNull: true,
        defaultValue: null,
      },
      assembledHash: {
        type: Sequelize.CHAR(64),
        allowNull: true,
        defaultValue: null,
      },
      result: {
        type: Sequelize.JSON,
        allowNull: true,
        defaultValue: null,
      },
      meta: {
        type: Sequelize.JSON,
        allowNull: true,
        defaultValue: null,
      },
      workspaceDir: {
        type: Sequelize.STRING(1024),
        allowNull: false,
      },
      errorMessage: {
        type: Sequelize.STRING(2048),
        allowNull: true,
        defaultValue: null,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      expiresAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
    });

    await queryInterface.addIndex('upload_sessions', ['kind', 'userId'], {
      name: 'idx_us_kind_user',
    });
    await queryInterface.addIndex('upload_sessions', ['status'], {
      name: 'idx_us_status',
    });
    await queryInterface.addIndex('upload_sessions', ['expiresAt'], {
      name: 'idx_us_expires',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('upload_sessions');
  },
};
