'use strict';

/**
 * Ranked eligibility: `CDN_URL` (this env) OR production `https://api.tuforums.com/cdn`.
 * Rebuilds the view so a prior alias of `cdn.tuforums.com` is not left in place.
 *
 * After this migration, run a full player ES reindex so `rankedScore` matches the view.
 */

const PUBLIC_CDN_BASE_URL = 'https://api.tuforums.com/cdn';

function escapeMysqlLikePrefix(prefix) {
  return String(prefix)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "''")
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

function stripTrailingSlash(url) {
  return String(url).replace(/\/+$/, '');
}

function availabilityCdnCaseSql() {
  const raw = process.env.CDN_URL;
  if (!raw || !String(raw).trim()) {
    throw new Error('CDN_URL must be set to rebuild player_pass_summary');
  }
  const writable = stripTrailingSlash(String(raw).trim());
  const pub = stripTrailingSlash(PUBLIC_CDN_BASE_URL);
  const prefixes = [writable];
  if (pub && pub !== writable) {
    prefixes.push(pub);
  }
  const likes = prefixes
    .map((prefix) => `dlLink LIKE '${escapeMysqlLikePrefix(prefix)}%' ESCAPE '\\\\'`)
    .join(' OR ');
  return `
            CASE
              WHEN dlLink IS NOT NULL AND dlLink != '' AND dlLink != 'removed' AND (${likes}) THEN 'Available (CDN)'
              ELSE 'Not Available'
            END COLLATE utf8mb4_0900_ai_ci as availability_status
  `;
}

const VIEW_SELECT = `
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
        COALESCE(NULLIF(l.ppBaseScore, 0), NULLIF(l.baseScore, 0), d.baseScore, 0) as ppBaseScore,
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
      AND p.isDuplicate = false
`;

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP VIEW IF EXISTS player_pass_summary;
    `);

    await queryInterface.sequelize.query(`
      CREATE VIEW player_pass_summary AS
      WITH LevelAvailability AS (
        SELECT
          id,
          ${availabilityCdnCaseSql()}
        FROM levels
      )
      ${VIEW_SELECT};
    `);
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
          ${availabilityCdnCaseSql()}
        FROM levels
      )
      ${VIEW_SELECT};
    `);
  },
};
