'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) { // Update pass summary view with external availability check
    await queryInterface.sequelize.query(`
      DROP VIEW IF EXISTS player_pass_summary;
    `);

    await queryInterface.sequelize.query(`
      CREATE VIEW player_pass_summary AS
      WITH LevelAvailability AS (
        SELECT 
          id,
          CASE 
            WHEN isExternallyAvailable = true THEN 'Available (Flag)'
            WHEN dlLink IS NOT NULL AND dlLink != '' THEN 'Available (DL Link)'
            WHEN workshopLink IS NOT NULL AND workshopLink != '' THEN 'Available (Workshop)'
            ELSE 'Not Available'
          END COLLATE utf8mb4_0900_ai_ci as availability_status
        FROM levels
      )
      SELECT 
        p.id,
        p.playerId,
        p.levelId,
        p.scoreV2,
        p.accuracy,
        p.isWorldsFirst,
        p.is12K,
        l.diffId,
        COALESCE(NULLIF(l.baseScore, 0), d.baseScore, 0) as baseScore,
        d.sortOrder,
        d.type,
        d.name,
        la.availability_status
      FROM passes p
      JOIN levels l ON p.levelId = l.id
      JOIN difficulties d ON l.diffId = d.id
      JOIN LevelAvailability la ON l.id = la.id
      WHERE p.isDeleted = false
      AND l.isDeleted = false
      AND p.isHidden = false
      AND p.isDuplicate = false;
    `);
  },

  async down(queryInterface, Sequelize) {
    // Drop the updated view
  }
}; 