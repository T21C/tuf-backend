'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Add isCommunityRating flag to rating_details table
      await queryInterface.addColumn('ratings', 'confirmedAt', {
        type: Sequelize.DATE,
        allowNull: true,
        defaultValue: null
      }, { transaction })


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