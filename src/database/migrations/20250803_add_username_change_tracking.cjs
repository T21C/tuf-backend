'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    
    try {
      // Add columns to track username changes
      await queryInterface.addColumn('users', 'lastUsernameChange', {
        type: Sequelize.DATE,
        allowNull: true,
        defaultValue: null,
        after: 'username'
      }, { transaction });

      await queryInterface.addColumn('users', 'previousUsername', {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: null,
        after: 'lastUsernameChange'
      }, { transaction });

      // Create a table to track username change history
      await queryInterface.createTable('username_changes', {
        id: {
          type: Sequelize.INTEGER,
          primaryKey: true,
          autoIncrement: true
        },
        userId: {
          type: Sequelize.UUID,
          allowNull: false,
          references: {
            model: 'users',
            key: 'id'
          },
          onDelete: 'CASCADE'
        },
        oldUsername: {
          type: Sequelize.STRING,
          allowNull: false
        },
        newUsername: {
          type: Sequelize.STRING,
          allowNull: false
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
      }, { transaction });

      // Add index for faster lookups
      await queryInterface.addIndex('username_changes', ['userId', 'updatedAt'], { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    // Check if table exists first
    const tableExists = await queryInterface.sequelize.query(
      `SELECT TABLE_NAME 
       FROM INFORMATION_SCHEMA.TABLES 
       WHERE TABLE_NAME = 'username_changes'`
    ).then(([results]) => results.length > 0);

    if (tableExists) {
      // Handle username_changes table cleanup
      try {
        // Remove foreign key first
        await queryInterface.sequelize.query(
          `ALTER TABLE username_changes DROP FOREIGN KEY username_changes_ibfk_1`
        );
      } catch (error) {
        console.log('Foreign key might already be removed:', error.message);
      }

      try {
        // Remove the index
        await queryInterface.sequelize.query(
          `DROP INDEX user_id_changed_at ON username_changes`
        );
      } catch (error) {
        console.log('Index might already be removed:', error.message);
      }

      // Drop the table
      await queryInterface.dropTable('username_changes');
    }

    // Check and remove columns from users table
    const [userColumns] = await queryInterface.sequelize.query(
      `SHOW COLUMNS FROM users`
    );
    
    const columnNames = userColumns.map(col => col.Field);

    if (columnNames.includes('previousUsername')) {
      await queryInterface.removeColumn('users', 'previousUsername');
    }

    if (columnNames.includes('lastUsernameChange')) {
      await queryInterface.removeColumn('users', 'lastUsernameChange');
    }
  }
}; 