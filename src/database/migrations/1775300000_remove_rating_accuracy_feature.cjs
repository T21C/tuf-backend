'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);

    const triggerNames = [
      'update_level_rating_accuracy_on_vote_insert',
      'update_level_rating_accuracy_on_vote_update',
      'update_level_rating_accuracy_on_vote_delete',
      'update_level_total_rating_accuracy_votes_on_vote_insert',
      'update_level_total_rating_accuracy_votes_on_vote_update',
      'update_level_total_rating_accuracy_votes_on_vote_delete',
      'update_level_rating_accuracy_on_diff_change',
      'update_level_total_rating_accuracy_votes_on_diff_change',
    ];

    for (const name of triggerNames) {
      await q(`DROP TRIGGER IF EXISTS ${name};`);
    }

    await q(`DROP PROCEDURE IF EXISTS update_level_rating_accuracy;`);

    await q(`DROP VIEW IF EXISTS level_rating_accuracy_view;`);

    await q(`DROP TABLE IF EXISTS level_rating_accuracy_vote;`);

    await q(`DROP VIEW IF EXISTS level_search_view;`);

    try {
      await queryInterface.removeColumn('levels', 'ratingAccuracy');
    } catch (e) {
      console.log('removeColumn ratingAccuracy:', e?.message || e);
    }
    try {
      await queryInterface.removeColumn('levels', 'totalRatingAccuracyVotes');
    } catch (e) {
      console.log('removeColumn totalRatingAccuracyVotes:', e?.message || e);
    }

    await q(`
      CREATE VIEW level_search_view AS
      SELECT
        l.id,
        l.song,
        l.artist,
        l.charter,
        l.team,
        l.teamId,
        l.diffId,
        l.baseScore,
        l.clears,
        l.likes,
        l.isDeleted,
        l.isHidden,
        l.isAnnounced,
        l.toRate,
        l.createdAt,
        l.updatedAt,
        d.sortOrder,
        d.type,
        d.name AS difficultyName,
        d.color AS difficultyColor,
        t.name AS teamName
      FROM levels l
      LEFT JOIN difficulties d ON l.diffId = d.id
      LEFT JOIN teams t ON l.teamId = t.id
      WHERE l.isDeleted = false;
    `);
  },

  async down() {
    throw new Error(
      '1775300000_remove_rating_accuracy_feature: rollback not supported. Restore from backup or re-run prior migrations in a fresh DB.'
    );
  },
};
