'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      await queryInterface.createTable('level_tag_assignments', {
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
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE'
        },
        tagId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: 'level_tags',
            key: 'id'
          },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE'
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

      // Add unique constraint on (levelId, tagId)
      await queryInterface.addIndex('level_tag_assignments', ['levelId', 'tagId'], {
        unique: true,
        name: 'level_tag_assignments_unique',
        transaction
      });

      // Add indexes for performance
      await queryInterface.addIndex('level_tag_assignments', ['levelId'], { transaction });
      await queryInterface.addIndex('level_tag_assignments', ['tagId'], { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      await queryInterface.dropTable('level_tag_assignments', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
