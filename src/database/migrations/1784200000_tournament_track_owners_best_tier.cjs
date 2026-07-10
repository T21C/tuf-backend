'use strict';

/**
 * Restore tournament track (player/creator), add ownerUserIds for visual editors,
 * and showBestTiersOnly for public profile placement dedupe.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('tournaments', 'track', {
      type: Sequelize.ENUM('player', 'creator'),
      allowNull: false,
      defaultValue: 'player',
    });

    await queryInterface.addColumn('tournaments', 'ownerUserIds', {
      type: Sequelize.JSON,
      allowNull: true,
    });

    await queryInterface.addColumn('tournaments', 'showBestTiersOnly', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    });

    await queryInterface.addIndex('tournaments', ['track'], {
      name: 'tournaments_track',
    });
  },

  async down(queryInterface) {
    try {
      await queryInterface.removeIndex('tournaments', 'tournaments_track');
    } catch {
      // index may not exist
    }

    await queryInterface.removeColumn('tournaments', 'showBestTiersOnly');
    await queryInterface.removeColumn('tournaments', 'ownerUserIds');
    await queryInterface.removeColumn('tournaments', 'track');
  },
};
