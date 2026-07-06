'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('players', 'hiddenPlacementIds', {
      type: Sequelize.JSON,
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addColumn('players', 'placementOrderIds', {
      type: Sequelize.JSON,
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addColumn('creators', 'hiddenPlacementIds', {
      type: Sequelize.JSON,
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addColumn('creators', 'placementOrderIds', {
      type: Sequelize.JSON,
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('creators', 'placementOrderIds');
    await queryInterface.removeColumn('creators', 'hiddenPlacementIds');
    await queryInterface.removeColumn('players', 'placementOrderIds');
    await queryInterface.removeColumn('players', 'hiddenPlacementIds');
  },
};
