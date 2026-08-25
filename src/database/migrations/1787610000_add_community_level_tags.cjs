'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn(
        'level_tags',
        'isCommunity',
        {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
          comment: 'When true, the public can vote this tag onto levels',
        },
        { transaction },
      );

      await queryInterface.addColumn(
        'level_tag_assignments',
        'pinned',
        {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
          comment: 'Staff pin; community rematerialize will not drop this assignment',
        },
        { transaction },
      );

      await queryInterface.addColumn(
        'level_tag_assignments',
        'score',
        {
          type: Sequelize.DOUBLE,
          allowNull: true,
          comment: 'Wilson lower-bound score from community votes; null for staff/auto tags',
        },
        { transaction },
      );

      await queryInterface.addColumn(
        'users',
        'isTagVoteBanned',
        {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        { transaction },
      );

      await queryInterface.createTable(
        'level_tag_votes',
        {
          id: {
            type: Sequelize.INTEGER,
            autoIncrement: true,
            primaryKey: true,
            allowNull: false,
          },
          userId: {
            type: Sequelize.UUID,
            allowNull: false,
            references: {
              model: 'users',
              key: 'id',
            },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
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
          weight: {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 1,
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

      await queryInterface.addIndex('level_tag_votes', ['userId', 'levelId', 'tagId'], {
        unique: true,
        name: 'level_tag_votes_user_level_tag_unique',
        transaction,
      });
      await queryInterface.addIndex('level_tag_votes', ['levelId', 'tagId'], {
        name: 'idx_level_tag_votes_level_tag',
        transaction,
      });
      await queryInterface.addIndex('level_tag_votes', ['userId', 'levelId'], {
        name: 'idx_level_tag_votes_user_level',
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
      await queryInterface.dropTable('level_tag_votes', { transaction });
      await queryInterface.removeColumn('users', 'isTagVoteBanned', { transaction });
      await queryInterface.removeColumn('level_tag_assignments', 'score', { transaction });
      await queryInterface.removeColumn('level_tag_assignments', 'pinned', { transaction });
      await queryInterface.removeColumn('level_tags', 'isCommunity', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
