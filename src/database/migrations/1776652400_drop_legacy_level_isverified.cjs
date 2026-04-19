'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      const levelsInfo = await queryInterface.describeTable('levels');
      if (levelsInfo.isVerified) {
        await queryInterface.removeColumn('levels', 'isVerified', { transaction });
      }

      const creditsInfo = await queryInterface.describeTable('level_credits');
      if (creditsInfo.isVerified) {
        await queryInterface.removeColumn('level_credits', 'isVerified', { transaction });
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      const levelsInfo = await queryInterface.describeTable('levels');
      if (!levelsInfo.isVerified) {
        await queryInterface.addColumn(
          'levels',
          'isVerified',
          {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: false,
          },
          { transaction },
        );
      }

      const creditsInfo = await queryInterface.describeTable('level_credits');
      if (!creditsInfo.isVerified) {
        await queryInterface.addColumn(
          'level_credits',
          'isVerified',
          {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: false,
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
};
