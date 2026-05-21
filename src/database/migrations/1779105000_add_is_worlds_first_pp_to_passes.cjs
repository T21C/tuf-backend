'use strict';

const { runMigrationWithCdcBulkShield } = require('./helpers/bulkMigrationCdcCoordination.cjs');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await runMigrationWithCdcBulkShield(queryInterface.sequelize, async () => {
    await queryInterface.addColumn('passes', 'isWorldsFirstPP', {
      type: require('sequelize').BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });

    try {
      await queryInterface.addIndex('passes', ['levelId', 'isWorldsFirstPP'], {
        name: 'idx_passes_level_wfpp',
      });
    } catch (error) {
      console.error('Error adding levelId, isWorldsFirstPP index:', error);
    }

    try {
      await queryInterface.addIndex('passes', ['playerId', 'isDeleted', 'isWorldsFirstPP'], {
        name: 'idx_passes_player_deleted_wfpp',
      });
    } catch (error) {
      console.error('Error adding playerId, isDeleted, isWorldsFirstPP index:', error);
    }

    await queryInterface.sequelize.query(`
      UPDATE passes SET isWorldsFirstPP = 0;
    `);

    await queryInterface.sequelize.query(`
      UPDATE passes p
      INNER JOIN (
        SELECT p2.levelId, MIN(p2.id) AS passId
        FROM passes p2
        INNER JOIN (
          SELECT levelId, MIN(vidUploadTime) AS minVidUploadTime
          FROM passes
          WHERE IFNULL(isDeleted, 0) = 0
            AND accuracy = 1
          GROUP BY levelId
        ) earliest ON p2.levelId = earliest.levelId
          AND p2.vidUploadTime = earliest.minVidUploadTime
        WHERE IFNULL(p2.isDeleted, 0) = 0
          AND p2.accuracy = 1
        GROUP BY p2.levelId
      ) winners ON p.id = winners.passId
      SET p.isWorldsFirstPP = 1;
    `);

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
        p.isWorldsFirstPP,
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
    });
  },

  async down(queryInterface) {
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

    try {
      await queryInterface.removeIndex('passes', 'idx_passes_player_deleted_wfpp');
    } catch (error) {
      console.error('Error removing idx_passes_player_deleted_wfpp:', error);
    }

    try {
      await queryInterface.removeIndex('passes', 'idx_passes_level_wfpp');
    } catch (error) {
      console.error('Error removing idx_passes_level_wfpp:', error);
    }

    await queryInterface.removeColumn('passes', 'isWorldsFirstPP');
  },
};
