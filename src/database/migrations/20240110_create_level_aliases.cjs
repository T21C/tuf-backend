'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('level_aliases', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      levelId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'levels',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      field: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      originalValue: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      alias: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
    });

    // Add unique constraint for field + originalValue + alias combination
    await queryInterface.addIndex('level_aliases', ['field', 'originalValue', 'alias'], {
      unique: true,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('level_aliases');
  }
}; 