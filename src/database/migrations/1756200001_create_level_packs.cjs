'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('level_packs', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false,
      },
      ownerId: {
        type: Sequelize.STRING,
        allowNull: false,
        comment: 'Discord ID of the pack owner',
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false,
        comment: 'Name of the level pack',
      },
      iconUrl: {
        type: Sequelize.STRING,
        allowNull: true,
        comment: 'CDN URL to custom icon for the pack',
      },
      cssFlags: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: 'Bit storage for CSS preset flags and theming options',
      },
      isPinned: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'Whether this pack should be shown when no query is provided',
      },
      viewMode: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: 'View mode: 1=public, 2=linkonly, 3=private, 4=forced private (admin override)',
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    // Add indexes for performance
    await queryInterface.addIndex('level_packs', ['ownerId'], {
      name: 'level_packs_owner_id'
    });
    
    await queryInterface.addIndex('level_packs', ['name'], {
      name: 'level_packs_name'
    });
    
    await queryInterface.addIndex('level_packs', ['isPinned'], {
      name: 'level_packs_is_pinned'
    });
    
    await queryInterface.addIndex('level_packs', ['viewMode'], {
      name: 'level_packs_view_mode'
    });
    
    await queryInterface.addIndex('level_packs', ['createdAt'], {
      name: 'level_packs_created_at'
    });
    
    await queryInterface.addIndex('level_packs', ['ownerId', 'isPinned'], {
      name: 'level_packs_owner_pinned'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('level_packs');
  }
};
