'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn(
        'levels',
        'xaccPoleOffset',
        {
          type: Sequelize.DOUBLE,
          allowNull: true,
          defaultValue: null,
        },
        { transaction },
      );
      await queryInterface.addColumn(
        'levels',
        'xaccTopMultiplier',
        {
          type: Sequelize.DOUBLE,
          allowNull: true,
          defaultValue: null,
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
      await queryInterface.removeColumn('levels', 'xaccTopMultiplier', { transaction });
      await queryInterface.removeColumn('levels', 'xaccPoleOffset', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
