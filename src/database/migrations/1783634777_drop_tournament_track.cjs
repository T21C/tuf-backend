'use strict';

/**
 * Drop tournament track (player/creator). Profile mode links players only;
 * creators come from level-mode credit expansion.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    await sequelize.query(
      `UPDATE tournament_placements tp
       INNER JOIN tournaments t ON t.id = tp.tournamentId
       SET tp.creatorId = NULL
       WHERE COALESCE(tp.rowMode, t.placementMode) = 'profile'
         AND tp.creatorId IS NOT NULL`,
    );

    try {
      await queryInterface.removeIndex('tournaments', 'tournaments_track');
    } catch {
      // index may not exist on all environments
    }

    await queryInterface.removeColumn('tournaments', 'track');
    await queryInterface.removeColumn('placement_rewards', 'track');
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.addColumn('tournaments', 'track', {
      type: Sequelize.ENUM('player', 'creator'),
      allowNull: false,
      defaultValue: 'player',
    });

    await queryInterface.addColumn('placement_rewards', 'track', {
      type: Sequelize.ENUM('player', 'creator'),
      allowNull: true,
    });

    await queryInterface.addIndex('tournaments', ['track'], {
      name: 'tournaments_track',
    });
  },
};
