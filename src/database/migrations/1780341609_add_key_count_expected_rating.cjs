'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn(
        'passes',
        'keyCount',
        {
          type: Sequelize.INTEGER,
          allowNull: true,
          defaultValue: null,
          comment: 'Number of keys used for this pass; derives is12K/is16K when set',
        },
        { transaction },
      );

      await queryInterface.addColumn(
        'passes',
        'expectedRating',
        {
          type: Sequelize.TEXT,
          allowNull: true,
          defaultValue: null,
          comment: 'Objective difficulty rating for the level',
        },
        { transaction },
      );

      await queryInterface.addColumn(
        'pass_submissions',
        'keyCount',
        {
          type: Sequelize.INTEGER,
          allowNull: true,
          defaultValue: null,
          comment: 'Number of keys used for this pass; derives is12K/is16K when set',
        },
        { transaction },
      );

      await queryInterface.addColumn(
        'pass_submissions',
        'expectedDifficulty',
        {
          type: Sequelize.TEXT,
          allowNull: true,
          defaultValue: null,
          comment: 'Objective difficulty rating for the level',
        },
        { transaction },
      );

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.removeColumn('passes', 'expectedRating', { transaction });
      await queryInterface.removeColumn('passes', 'keyCount', { transaction });
      await queryInterface.removeColumn('pass_submissions', 'expectedDifficulty', { transaction });
      await queryInterface.removeColumn('pass_submissions', 'keyCount', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
