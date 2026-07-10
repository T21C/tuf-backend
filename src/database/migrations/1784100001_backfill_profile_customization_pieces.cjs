'use strict';

/**
 * Backfill profile_customization_pieces from players/creators presentation columns.
 * Does not auto-link player/creator pairs.
 */

function buildBannerPayload(row) {
  const bannerPreset =
    typeof row.bannerPreset === 'string' && row.bannerPreset.length ? row.bannerPreset : null;
  const customBannerId =
    typeof row.customBannerId === 'string' && row.customBannerId.length ? row.customBannerId : null;
  const customBannerUrl =
    typeof row.customBannerUrl === 'string' && row.customBannerUrl.length ? row.customBannerUrl : null;
  if (!bannerPreset && !customBannerId && !customBannerUrl) return null;
  return JSON.stringify({ bannerPreset, customBannerId, customBannerUrl });
}

function buildHeaderSurfacePayload(row) {
  const style =
    row.profileHeaderSurfaceStyle && typeof row.profileHeaderSurfaceStyle === 'object'
      ? row.profileHeaderSurfaceStyle
      : null;
  const assets =
    row.profileHeaderSurfaceImageAssets &&
    typeof row.profileHeaderSurfaceImageAssets === 'object' &&
    !Array.isArray(row.profileHeaderSurfaceImageAssets)
      ? row.profileHeaderSurfaceImageAssets
      : null;
  if (!style && !assets) return null;
  return JSON.stringify({ profileHeaderSurfaceStyle: style, profileHeaderSurfaceImageAssets: assets });
}

function buildBioPayload(row) {
  const bio = typeof row.bio === 'string' && row.bio.trim().length ? row.bio.trim() : null;
  const bioCanvas =
    row.bioCanvas && typeof row.bioCanvas === 'object' && !Array.isArray(row.bioCanvas)
      ? row.bioCanvas
      : null;
  const bioCanvasImageAssets =
    row.bioCanvasImageAssets &&
    typeof row.bioCanvasImageAssets === 'object' &&
    !Array.isArray(row.bioCanvasImageAssets)
      ? row.bioCanvasImageAssets
      : null;
  if (!bio && !bioCanvas && !bioCanvasImageAssets) return null;
  return JSON.stringify({ bio, bioCanvas, bioCanvasImageAssets });
}

function normalizeStellar(raw) {
  const s = raw == null ? '' : String(raw).trim();
  if (s === '2' || s === '3') return s;
  return '1';
}

function buildStellarPayload(row) {
  return JSON.stringify({ tufStellarIconVariant: normalizeStellar(row.tufStellarIconVariant) });
}

async function insertPiece(queryInterface, { userId, playerId, creatorId, unit, payloadJson, now, transaction }) {
  await queryInterface.sequelize.query(
    `INSERT INTO profile_customization_pieces
       (userId, playerId, creatorId, unit, payload, createdAt, updatedAt)
     VALUES (:userId, :playerId, :creatorId, :unit, CAST(:payload AS JSON), :now, :now)`,
    {
      replacements: {
        userId,
        playerId,
        creatorId,
        unit,
        payload: payloadJson,
        now,
      },
      transaction,
    },
  );
}

async function backfillEntityRows(queryInterface, { table, idColumn, transaction, now }) {
  const [rows] = await queryInterface.sequelize.query(
    `SELECT p.id AS entityId,
            u.id AS userId,
            p.bannerPreset,
            p.customBannerId,
            p.customBannerUrl,
            p.profileHeaderSurfaceStyle,
            p.profileHeaderSurfaceImageAssets,
            p.bio,
            p.bioCanvas,
            p.bioCanvasImageAssets,
            p.tufStellarIconVariant
     FROM ${table} p
     LEFT JOIN users u ON u.${idColumn} = p.id
     WHERE u.id IS NOT NULL`,
    { transaction },
  );

  for (const row of rows) {
    const userId = row.userId;
    const entityId = row.entityId;
    const playerId = table === 'players' ? entityId : null;
    const creatorId = table === 'creators' ? entityId : null;

    const banner = buildBannerPayload(row);
    if (banner) {
      await insertPiece(queryInterface, {
        userId,
        playerId,
        creatorId,
        unit: 'banner',
        payloadJson: banner,
        now,
        transaction,
      });
    }

    const header = buildHeaderSurfacePayload(row);
    if (header) {
      await insertPiece(queryInterface, {
        userId,
        playerId,
        creatorId,
        unit: 'header_surface',
        payloadJson: header,
        now,
        transaction,
      });
    }

    const bio = buildBioPayload(row);
    if (bio) {
      await insertPiece(queryInterface, {
        userId,
        playerId,
        creatorId,
        unit: 'bio',
        payloadJson: bio,
        now,
        transaction,
      });
    }

    await insertPiece(queryInterface, {
      userId,
      playerId,
      creatorId,
      unit: 'stellar_icon',
      payloadJson: buildStellarPayload(row),
      now,
      transaction,
    });
  }
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    const now = new Date();
    try {
      await backfillEntityRows(queryInterface, {
        table: 'players',
        idColumn: 'playerId',
        transaction,
        now,
      });
      await backfillEntityRows(queryInterface, {
        table: 'creators',
        idColumn: 'creatorId',
        transaction,
        now,
      });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(`DELETE FROM profile_customization_pieces`, { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
