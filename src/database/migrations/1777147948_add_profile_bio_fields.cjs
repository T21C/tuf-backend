'use strict';

/** Adds `bio` on `players` and `creators`. */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      for (const table of ['players', 'creators']) {
        await queryInterface.addColumn(
          table,
          'bio',
          {
            type: Sequelize.TEXT,
            allowNull: true,
          },
          { transaction },
        );
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      for (const table of ['players', 'creators']) {
        await queryInterface.removeColumn(table, 'bio', { transaction });
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};

