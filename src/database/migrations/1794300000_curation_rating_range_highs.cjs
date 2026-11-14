'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const desc = await queryInterface.describeTable('curation_rating_details');
      if (!desc.chartTypeHighId) {
        await queryInterface.addColumn(
          'curation_rating_details',
          'chartTypeHighId',
          {
            type: Sequelize.INTEGER,
            allowNull: true,
            defaultValue: null,
          },
          {transaction},
        );
      }
      if (!desc.vfxTypeHighId) {
        await queryInterface.addColumn(
          'curation_rating_details',
          'vfxTypeHighId',
          {
            type: Sequelize.INTEGER,
            allowNull: true,
            defaultValue: null,
          },
          {transaction},
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
      const desc = await queryInterface.describeTable('curation_rating_details');
      if (desc.chartTypeHighId) {
        await queryInterface.removeColumn('curation_rating_details', 'chartTypeHighId', {transaction});
      }
      if (desc.vfxTypeHighId) {
        await queryInterface.removeColumn('curation_rating_details', 'vfxTypeHighId', {transaction});
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
