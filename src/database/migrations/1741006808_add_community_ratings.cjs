'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Add isCommunityRating flag to rating_details table
      await queryInterface.addColumn('rating_details', 'isCommunityRating', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      }, { transaction });

      // Add isRatingBanned flag to users table
      await queryInterface.addColumn('users', 'isRatingBanned', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      }, { transaction });

      // Add communityDifficultyId to ratings table for tracking community average
      await queryInterface.addColumn('ratings', 'communityDifficultyId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'difficulties',
          key: 'id',
        },
      }, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Remove the columns in reverse order
      await queryInterface.removeColumn('ratings', 'communityDifficultyId', { transaction });
      await queryInterface.removeColumn('users', 'isRatingBanned', { transaction });
      await queryInterface.removeColumn('rating_details', 'isCommunityRating', { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
}; 