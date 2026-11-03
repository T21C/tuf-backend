'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn(
        'passes',
        'feelingExplanation',
        {
          type: Sequelize.TEXT,
          allowNull: true,
          defaultValue: null,
          comment: 'Optional explanation of the feeling rating, used for GQ/UQ clears',
        },
        { transaction },
      );

      await queryInterface.addColumn(
        'pass_submissions',
        'feelingExplanation',
        {
          type: Sequelize.TEXT,
          allowNull: true,
          defaultValue: null,
          comment: 'Optional explanation of the feeling rating supplied with a GQ/UQ clear',
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
      await queryInterface.removeColumn('pass_submissions', 'feelingExplanation', { transaction });
      await queryInterface.removeColumn('passes', 'feelingExplanation', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
