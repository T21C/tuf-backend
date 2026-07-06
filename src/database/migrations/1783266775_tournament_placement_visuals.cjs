'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const assetColumns = {
      iconAssetId: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      iconUrl: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      cardBackgroundAssetId: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      cardBackgroundUrl: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
    };

    for (const [table, cols] of [
      ['tournaments', assetColumns],
      ['tournament_tiers', assetColumns],
    ]) {
      for (const [name, def] of Object.entries(cols)) {
        await queryInterface.addColumn(table, name, def);
      }
    }
  },

  async down(queryInterface) {
    for (const table of ['tournament_tiers', 'tournaments']) {
      for (const col of [
        'cardBackgroundUrl',
        'cardBackgroundAssetId',
        'iconUrl',
        'iconAssetId',
      ]) {
        await queryInterface.removeColumn(table, col);
      }
    }
  },
};
