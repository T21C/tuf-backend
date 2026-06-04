'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn(
        'level_credits',
        'sortOrder',
        {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
          comment: 'Display order of credits within a level',
        },
        { transaction },
      );

      await queryInterface.addIndex(
        'level_credits',
        ['levelId', 'sortOrder'],
        {
          name: 'level_credits_levelId_sortOrder',
          transaction,
        },
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
      await queryInterface.removeIndex(
        'level_credits',
        'level_credits_levelId_sortOrder',
        { transaction },
      );
      await queryInterface.removeColumn('level_credits', 'sortOrder', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
