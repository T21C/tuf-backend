'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const mainDatabase = process.env.DB_DATABASE;
    const loggingDatabase = process.env.DB_LOGGING_DATABASE || 'tuf_logging';

    // Step 1: Create the logging database
    await queryInterface.sequelize.query(`CREATE DATABASE IF NOT EXISTS \`${loggingDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);

    // Step 2: Switch to logging database
    await queryInterface.sequelize.query(`USE \`${loggingDatabase}\`;`);

    try {
    // Step 3: Create file_access_logs table in logging database
    await queryInterface.createTable('file_access_logs', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true
      },
      fileId: {
        type: Sequelize.UUID,
        allowNull: false,
        // Note: Foreign key removed since cdn_files is in main database
        // We'll store the fileId as UUID but won't enforce referential integrity
      },
      ipAddress: {
        type: Sequelize.STRING,
        allowNull: false
      },
      userAgent: {
        type: Sequelize.STRING(500),
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

    // Step 4: Create endpoint_access_logs table in logging database
    await queryInterface.createTable('endpoint_access_logs', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true
      },
      method: {
        type: Sequelize.STRING(10),
        allowNull: false,
        comment: 'HTTP method (GET, POST, PUT, DELETE, etc.)'
      },
      path: {
        type: Sequelize.STRING(500),
        allowNull: false,
        comment: 'API endpoint path'
      },
      statusCode: {
        type: Sequelize.INTEGER,
        allowNull: false,
        comment: 'HTTP status code'
      },
      responseTime: {
        type: Sequelize.INTEGER,
        allowNull: true,
        comment: 'Response time in milliseconds'
      },
      ipAddress: {
        type: Sequelize.STRING,
        allowNull: false
      },
      userAgent: {
        type: Sequelize.STRING(500),
        allowNull: true
      },
      userId: {
        type: Sequelize.UUID,
        allowNull: true,
        comment: 'User ID if authenticated'
      },
      queryParams: {
        type: Sequelize.JSON,
        allowNull: true,
        comment: 'Query parameters as JSON object'
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
    } catch (error) {
      console.error('Error creating endpoint_access_logs table:', error);
    }

    try {
    // Step 5: Add indexes for better query performance
    await queryInterface.addIndex('file_access_logs', ['fileId']);
    await queryInterface.addIndex('file_access_logs', ['createdAt']);
    await queryInterface.addIndex('endpoint_access_logs', ['path']);
    await queryInterface.addIndex('endpoint_access_logs', ['method']);
    await queryInterface.addIndex('endpoint_access_logs', ['statusCode']);
    await queryInterface.addIndex('endpoint_access_logs', ['createdAt']);
    await queryInterface.addIndex('endpoint_access_logs', ['userId']);

    } catch (error) {
      console.error('Error adding indexes to file_access_logs and endpoint_access_logs:', error);
    }
    // Step 6: Move existing file_access_logs data from main database to logging database
    const [existingLogs] = await queryInterface.sequelize.query(
      `SELECT * FROM \`${mainDatabase}\`.file_access_logs`
    );

    if (existingLogs && existingLogs.length > 0) {
      // Insert in batches to avoid memory issues
      const batchSize = 1000;
      for (let i = 0; i < existingLogs.length; i += batchSize) {
        const batch = existingLogs.slice(i, i + batchSize);
        // Use Sequelize's bulkInsert for safe parameterized queries
        const logData = batch.map(log => ({
          id: log.id,
          fileId: log.fileId,
          ipAddress: log.ipAddress,
          userAgent: log.userAgent.substring(0, 500),
          createdAt: log.createdAt,
          updatedAt: log.updatedAt
        }));
        
        await queryInterface.bulkInsert('file_access_logs', logData, {
          updateOnDuplicate: ['fileId', 'ipAddress', 'userAgent', 'updatedAt']
        });
      }
    }

    // Step 7: Drop file_access_logs table from main database
    await queryInterface.sequelize.query(`USE \`${mainDatabase}\`;`);
    await queryInterface.dropTable('file_access_logs');
  },

  async down(queryInterface, Sequelize) {
    const mainDatabase = process.env.DB_DATABASE;
    const loggingDatabase = process.env.DB_LOGGING_DATABASE || 'tuf_logging';

    // Step 1: Recreate file_access_logs table in main database
    await queryInterface.sequelize.query(`USE \`${mainDatabase}\`;`);
    
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

    await queryInterface.addIndex('file_access_logs', ['fileId']);

    // Step 2: Move data back from logging database to main database
    const [existingLogs] = await queryInterface.sequelize.query(
      `SELECT * FROM \`${loggingDatabase}\`.file_access_logs`
    );

    if (existingLogs && existingLogs.length > 0) {
      const batchSize = 1000;
      for (let i = 0; i < existingLogs.length; i += batchSize) {
        const batch = existingLogs.slice(i, i + batchSize);
        // Use Sequelize's bulkInsert for safe parameterized queries
        const logData = batch.map(log => ({
          id: log.id,
          fileId: log.fileId,
          ipAddress: log.ipAddress,
          userAgent: log.userAgent,
          createdAt: log.createdAt,
          updatedAt: log.updatedAt
        }));
        
        await queryInterface.bulkInsert('file_access_logs', logData, {
          updateOnDuplicate: ['fileId', 'ipAddress', 'userAgent', 'updatedAt']
        });
      }
    }

    // Step 3: Drop tables from logging database
    await queryInterface.sequelize.query(`USE \`${loggingDatabase}\`;`);
    await queryInterface.dropTable('endpoint_access_logs');
    await queryInterface.dropTable('file_access_logs');

    // Step 4: Drop logging database (optional - commented out to preserve data)
    // await queryInterface.sequelize.query(`DROP DATABASE IF EXISTS \`${loggingDatabase}\`;`);
  }
};
