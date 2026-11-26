'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.createTable(
        'level_community_tag_vote_blocks',
        {
          id: {
            type: Sequelize.INTEGER,
            autoIncrement: true,
            primaryKey: true,
            allowNull: false,
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
          tagId: {
            type: Sequelize.INTEGER,
            allowNull: false,
            references: {
              model: 'level_tags',
              key: 'id',
            },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          createdAt: {
            type: Sequelize.DATE,
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
          },
          updatedAt: {
            type: Sequelize.DATE,
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'),
          },
        },
        { transaction },
      );

      await queryInterface.addIndex('level_community_tag_vote_blocks', ['levelId', 'tagId'], {
        unique: true,
        name: 'level_community_tag_vote_blocks_level_tag_unique',
        transaction,
      });
      await queryInterface.addIndex('level_community_tag_vote_blocks', ['levelId'], {
        name: 'idx_level_community_tag_vote_blocks_level',
        transaction,
      });
      await queryInterface.addIndex('level_community_tag_vote_blocks', ['tagId'], {
        name: 'idx_level_community_tag_vote_blocks_tag',
        transaction,
      });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.dropTable('level_community_tag_vote_blocks', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
