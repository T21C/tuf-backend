'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('levelpackitems', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true
      },
      packId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'levelpacks',
          key: 'id'
        },
        onDelete: 'CASCADE',
        comment: 'Reference to the level pack'
      },
      levelId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'levels',
          key: 'id'
        },
        onDelete: 'CASCADE',
        comment: 'Reference to the level'
      },
      sortOrder: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: 'Order of the level within the pack (for reorderable functionality)'
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
    await queryInterface.addIndex('levelpackitems', ['packId']);
    await queryInterface.addIndex('levelpackitems', ['levelId']);
    await queryInterface.addIndex('levelpackitems', ['sortOrder']);
    
    // Add composite index for efficient pack ordering queries
    await queryInterface.addIndex('levelpackitems', ['packId', 'sortOrder']);
    
    // Add unique constraint to prevent duplicate levels in the same pack
    await queryInterface.addConstraint('levelpackitems', {
      fields: ['packId', 'levelId'],
      type: 'unique',
      name: 'levelpackitems_pack_level_unique'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('levelpackitems');
  }
};
