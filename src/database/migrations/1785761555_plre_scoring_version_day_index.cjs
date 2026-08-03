'use strict';

/**
 * Covering index for historical leaderboard reconstruction:
 *   WHERE scoringVersion = ? AND effectiveDay <= ?
 *   GROUP BY playerId / MAX(effectiveDay)
 *
 * Existing unique index is (scoringVersion, playerId, effectiveDay) which is
 * optimized for per-player lookups, not date-range board rebuilds.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const indexes = await queryInterface.showIndex('player_leaderboard_rank_events');
    const names = new Set(indexes.map((idx) => idx.name));

    if (!names.has('idx_plre_version_day_player')) {
      await queryInterface.addIndex(
        'player_leaderboard_rank_events',
        ['scoringVersion', 'effectiveDay', 'playerId'],
        { name: 'idx_plre_version_day_player' },
      );
    }
  },

  async down(queryInterface) {
    const indexes = await queryInterface.showIndex('player_leaderboard_rank_events');
    const names = new Set(indexes.map((idx) => idx.name));

    if (names.has('idx_plre_version_day_player')) {
      await queryInterface.removeIndex(
        'player_leaderboard_rank_events',
        'idx_plre_version_day_player',
      );
    }
  },
};
