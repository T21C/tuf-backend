'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Drop the view if it exists
    await queryInterface.sequelize.query(`
      DROP VIEW IF EXISTS level_search_view;
    `);

    // Create the view with all one-to-one fields used for search
    await queryInterface.sequelize.query(`
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
    console.log('Created level_search_view with all one-to-one fields used for search');
  },

  async down(queryInterface, Sequelize) {
    // Drop the view
    await queryInterface.sequelize.query(`
      DROP VIEW IF EXISTS level_search_view;
    `);
    console.log('Dropped level_search_view');
  }
}; 