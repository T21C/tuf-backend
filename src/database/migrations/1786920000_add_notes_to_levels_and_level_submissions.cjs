'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn(
        'level_submissions',
        'notes',
        {
          type: Sequelize.TEXT,
          allowNull: true,
          defaultValue: null,
          comment: 'Optional submitter/staff notes copied onto the level on approve',
        },
        { transaction },
      );

      await queryInterface.addColumn(
        'levels',
        'notes',
        {
          type: Sequelize.TEXT,
          allowNull: true,
          defaultValue: null,
          comment: 'Optional submitter/staff notes from the level submission',
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
      await queryInterface.removeColumn('level_submissions', 'notes', { transaction });
      await queryInterface.removeColumn('levels', 'notes', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
