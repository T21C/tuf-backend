'use strict';

/**
 * Backfill tournament_placement_credits for profile-mode placements that were
 * linked to a player/creator without materializing a credit row (e.g. via
 * PATCH placement or resolve-names before credit sync was added).
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const now = new Date();

    await sequelize.query(
      `INSERT INTO tournament_placement_credits
         (placementId, playerId, creatorId, isGuest, sortOrder, createdAt, updatedAt)
       SELECT
         tp.id,
         tp.playerId,
         tp.creatorId,
         0,
         0,
         :now,
         :now
       FROM tournament_placements tp
       INNER JOIN tournaments t ON t.id = tp.tournamentId
       WHERE COALESCE(tp.rowMode, t.placementMode) = 'profile'
         AND (
           (t.track = 'player' AND tp.playerId IS NOT NULL)
           OR (t.track = 'creator' AND tp.creatorId IS NOT NULL)
         )
         AND NOT EXISTS (
           SELECT 1
           FROM tournament_placement_credits c
           WHERE c.placementId = tp.id
         )`,
      {replacements: {now}},
    );
  },

  async down() {
    // Data repair only; no safe automatic rollback.
  },
};
