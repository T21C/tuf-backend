'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('levelpacks', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true
      },
      ownerId: {
        type: Sequelize.STRING,
        allowNull: false,
        comment: 'Discord ID of the pack owner'
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false,
        comment: 'Name of the level pack'
      },
      iconUrl: {
        type: Sequelize.STRING,
        allowNull: true,
        comment: 'CDN URL to custom icon for the pack'
      },
      cssFlags: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: 'Bit storage for CSS preset flags and theming options'
      },
      isPinned: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'Whether this pack should be shown when no query is provided'
      },
      viewMode: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: 'View mode: 1=public, 2=linkonly, 3=private, 4=forced private (admin override)'
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

    // Add indexes for performance
    await queryInterface.addIndex('levelpacks', ['ownerId']);
    await queryInterface.addIndex('levelpacks', ['name']);
    await queryInterface.addIndex('levelpacks', ['isPinned']);
    await queryInterface.addIndex('levelpacks', ['viewMode']);
    await queryInterface.addIndex('levelpacks', ['createdAt']);
    
    // Add composite index for owner + pinned for efficient pinned pack queries
    await queryInterface.addIndex('levelpacks', ['ownerId', 'isPinned']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('levelpacks');
  }
};
