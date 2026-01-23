'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Add songId and artistId to levels table
      await queryInterface.addColumn('levels', 'songId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'songs',
          key: 'id'
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE'
      }, { transaction });

      // Add indexes for levels
      await queryInterface.addIndex('levels', ['songId'], { transaction });

      // Add songId, artistId, songRequestId, artistRequestId to level_submissions table
      await queryInterface.addColumn('level_submissions', 'songId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'songs',
          key: 'id'
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE'
      }, { transaction });

      await queryInterface.addColumn('level_submissions', 'artistId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'artists',
          key: 'id'
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE'
      }, { transaction });

      await queryInterface.addColumn('level_submissions', 'songRequestId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'level_submission_song_requests',
          key: 'id'
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE'
      }, { transaction });

      await queryInterface.addColumn('level_submissions', 'artistRequestId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'level_submission_artist_requests',
          key: 'id'
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE'
      }, { transaction });

      // Add indexes for level_submissions
      await queryInterface.addIndex('level_submissions', ['songId'], { transaction });
      await queryInterface.addIndex('level_submissions', ['artistId'], { transaction });
      await queryInterface.addIndex('level_submissions', ['songRequestId'], { transaction });
      await queryInterface.addIndex('level_submissions', ['artistRequestId'], { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Remove indexes first
      await queryInterface.removeIndex('level_submissions', ['artistRequestId'], { transaction });
      await queryInterface.removeIndex('level_submissions', ['songRequestId'], { transaction });
      await queryInterface.removeIndex('level_submissions', ['artistId'], { transaction });
      await queryInterface.removeIndex('level_submissions', ['songId'], { transaction });
      await queryInterface.removeIndex('levels', ['songId'], { transaction });

      // Remove columns from level_submissions
      await queryInterface.removeColumn('level_submissions', 'artistRequestId', { transaction });
      await queryInterface.removeColumn('level_submissions', 'songRequestId', { transaction });
      await queryInterface.removeColumn('level_submissions', 'artistId', { transaction });
      await queryInterface.removeColumn('level_submissions', 'songId', { transaction });

      // Remove columns from levels
      await queryInterface.removeColumn('levels', 'songId', { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
