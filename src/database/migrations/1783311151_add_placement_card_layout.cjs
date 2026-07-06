'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('players', 'placementCardLayout', {
      type: Sequelize.STRING(16),
      allowNull: false,
      defaultValue: 'default',
    });
    await queryInterface.addColumn('creators', 'placementCardLayout', {
      type: Sequelize.STRING(16),
      allowNull: false,
      defaultValue: 'default',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('creators', 'placementCardLayout');
    await queryInterface.removeColumn('players', 'placementCardLayout');
  },
};
