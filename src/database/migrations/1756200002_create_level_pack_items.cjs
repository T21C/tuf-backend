'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('level_pack_items', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      packId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'level_packs',
          key: 'id',
        },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        comment: 'Reference to the parent pack container',
      },
      type: {
        type: Sequelize.ENUM('folder', 'level'),
        allowNull: false,
        defaultValue: 'level',
        comment: 'Type of item: folder or level',
      },
      parentId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'level_pack_items',
          key: 'id',
        },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        comment: 'Parent item ID for tree structure within pack (null = root level)',
      },
      name: {
        type: Sequelize.STRING,
        allowNull: true,
        comment: 'Name of the folder (null for level items)',
      },
      levelId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'levels',
          key: 'id',
        },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        comment: 'Reference to the level (null for folder items)',
      },
      sortOrder: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: 'Sort order within parent folder',
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
    await queryInterface.addIndex('level_pack_items', ['packId'], {
      name: 'level_pack_items_pack_id'
    });
    
    await queryInterface.addIndex('level_pack_items', ['levelId'], {
      name: 'level_pack_items_level_id'
    });
    
    await queryInterface.addIndex('level_pack_items', ['parentId'], {
      name: 'level_pack_items_parent_id'
    });
    
    await queryInterface.addIndex('level_pack_items', ['type'], {
      name: 'level_pack_items_type'
    });
    
    // Composite index for efficient tree queries and sorting
    await queryInterface.addIndex('level_pack_items', ['packId', 'parentId', 'sortOrder'], {
      name: 'level_pack_items_pack_parent_sort'
    });

    // Unique constraint: folder names must be unique within the same parent in the same pack
    await queryInterface.addConstraint('level_pack_items', {
      fields: ['packId', 'parentId', 'name'],
      type: 'unique',
      name: 'unique_folder_name_per_parent',
    });

    // Check constraint: folders must have name, levels must have levelId
    // Note: This is enforced at the application level since MySQL doesn't support complex check constraints pre-8.0.16
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('level_pack_items');
  }
};
