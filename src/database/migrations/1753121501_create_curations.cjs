'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('curations', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true
      },
      levelId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'levels',
          key: 'id'
        },
        onDelete: 'CASCADE'
      },
      typeId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'curation_types',
          key: 'id'
        },
        onDelete: 'CASCADE'
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      previewLink: {
        type: Sequelize.STRING,
        allowNull: true,
        comment: 'CDN link to preview image/gif'
      },
      customCSS: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      customColor: {
        type: Sequelize.STRING,
        allowNull: true
      },
      assignedBy: {
        type: Sequelize.STRING,
        allowNull: false,
        comment: 'Discord ID of the person who assigned this curation'
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
    await queryInterface.addIndex('curations', ['levelId']);
    await queryInterface.addIndex('curations', ['typeId']);
    await queryInterface.addIndex('curations', ['assignedBy']);
    await queryInterface.addIndex('curations', ['createdAt']);
    
    // Add unique constraint to prevent duplicate curations for same level and type
    await queryInterface.addConstraint('curations', {
      fields: ['levelId', 'typeId'],
      type: 'unique',
      name: 'curations_level_type_unique'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('curations');
  }
};
