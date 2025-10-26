'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {    
    await queryInterface.addColumn('level_rerate_histories', 'oldLegacyValue', {
      type: Sequelize.STRING,
      allowNull: true,
      defaultValue: null
    });
    await queryInterface.addColumn('level_rerate_histories', 'newLegacyValue', {
      type: Sequelize.STRING,
      allowNull: true,
      defaultValue: null
    });
    await queryInterface.changeColumn('level_rerate_histories', 'previousDiffId', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.changeColumn('level_rerate_histories', 'newDiffId', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('level_rerate_histories', 'oldLegacyValue');
    await queryInterface.removeColumn('level_rerate_histories', 'newLegacyValue');
    await queryInterface.changeColumn('level_rerate_histories', 'previousDiffId', {
      type: Sequelize.INTEGER,
      allowNull: false,
      references: { model: 'difficulties', key: 'id' }
    });
    await queryInterface.changeColumn('level_rerate_histories', 'newDiffId', {
      type: Sequelize.INTEGER,
      allowNull: false,
      references: { model: 'difficulties', key: 'id' }
    });
  }
};