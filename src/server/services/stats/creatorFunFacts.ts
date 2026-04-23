import {getSequelizeForModelGroup} from '@/config/db.js';
import sequelize from '@/config/db.js';
import {QueryTypes} from 'sequelize';
import type {CreatorFunFacts} from '@/server/interfaces/stats/funFacts.js';
import {
  emptyClearsByDifficultyType,
  mergeDifficultyTypeCounts,
} from '@/server/services/stats/funFactsShape.js';

const levelsSequelize = getSequelizeForModelGroup('levels');
const passesSequelize = getSequelizeForModelGroup('passes');
const creditsSequelize = getSequelizeForModelGroup('credits');
const curationsSequelize = getSequelizeForModelGroup('curations');

function toIso(d: unknown): string | null {
  if (!d) return null;
  if (d instanceof Date && !Number.isNaN(d.getTime())) return d.toISOString();
  const t = new Date(String(d));
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

export async function computeCreatorFunFacts(creatorId: number): Promise<CreatorFunFacts> {
  const empty: CreatorFunFacts = {
    identity: {aliasCount: 0, teamsJoined: 0},
    credits: {
      levelsCreditedDistinct: 0,
      levelsAsCharter: 0,
      levelsAsVfxer: 0,
      levelsAsCreator: 0,
      levelsAsTeamMember: 0,
      levelsOwned: 0,
    },
    content: {
      totalTilesMade: 0,
      totalLevelDurationMs: 0,
      averageTilecount: 0,
      averageLevelLengthMs: 0,
      averageBpm: 0,
      totalClearsOnLevels: 0,
      totalLikesOnLevels: 0,
      totalDownloadsOnLevels: 0,
    },
    audience: {uniquePlayersCleared: 0, worldsFirstsOnLevels: 0, totalTilesPlayedOnLevels: 0},
    curation: {curatedLevels: 0, rerateCount: 0},
    timeline: {firstLevelAt: null, latestLevelAt: null},
    levelsByDifficulty: {},
    levelsByDifficultyType: {...emptyClearsByDifficultyType()},
  };

  if (!Number.isFinite(creatorId) || creatorId <= 0) return empty;

  const contentSql = `
    SELECT
      COUNT(*) AS distinctLevels,
      COALESCE(SUM(x.tilecount), 0) AS totalTilesMade,
      COALESCE(SUM(x.levelLengthInMs), 0) AS totalLevelDurationMs,
      COALESCE(AVG(x.tilecount), 0) AS averageTilecount,
      COALESCE(AVG(x.levelLengthInMs), 0) AS averageLevelLengthMs,
      COALESCE(AVG(x.bpm), 0) AS averageBpm,
      COALESCE(SUM(x.clears), 0) AS totalClearsOnLevels,
      COALESCE(SUM(x.likes), 0) AS totalLikesOnLevels,
      COALESCE(SUM(x.downloadCount), 0) AS totalDownloadsOnLevels,
      MIN(x.levelCreatedAt) AS firstLevelAt,
      MAX(x.levelCreatedAt) AS latestLevelAt
    FROM (
      SELECT
        l.id,
        MAX(IFNULL(l.tilecount, 0)) AS tilecount,
        MAX(IFNULL(l.levelLengthInMs, 0)) AS levelLengthInMs,
        MAX(IFNULL(l.bpm, 0)) AS bpm,
        MAX(l.clears) AS clears,
        MAX(l.likes) AS likes,
        MAX(l.downloadCount) AS downloadCount,
        MAX(l.createdAt) AS levelCreatedAt
      FROM level_credits lc
      INNER JOIN levels l ON l.id = lc.levelId AND l.isDeleted = 0
      WHERE lc.creatorId = :creatorId
      GROUP BY l.id
    ) x
  `;

  const creditsSql = `
    SELECT
      COUNT(DISTINCT lc.levelId) AS levelsCreditedDistinct,
      COUNT(DISTINCT CASE WHEN lc.role = 'charter' THEN lc.levelId END) AS levelsAsCharter,
      COUNT(DISTINCT CASE WHEN lc.role = 'vfxer' THEN lc.levelId END) AS levelsAsVfxer,
      COUNT(DISTINCT CASE WHEN lc.role = 'creator' THEN lc.levelId END) AS levelsAsCreator,
      COUNT(DISTINCT CASE WHEN lc.role = 'team_member' THEN lc.levelId END) AS levelsAsTeamMember,
      COUNT(DISTINCT CASE WHEN lc.isOwner = 1 THEN lc.levelId END) AS levelsOwned
    FROM level_credits lc
    INNER JOIN levels l ON l.id = lc.levelId AND l.isDeleted = 0
    WHERE lc.creatorId = :creatorId
  `;

  const diffSql = `
    SELECT l.diffId AS diffId, d.type AS diffType, COUNT(DISTINCT l.id) AS cnt
    FROM level_credits lc
    INNER JOIN levels l ON l.id = lc.levelId AND l.isDeleted = 0
    INNER JOIN difficulties d ON d.id = l.diffId
    WHERE lc.creatorId = :creatorId
    GROUP BY l.diffId, d.type
  `;

  const audienceSql = `
    SELECT
      COUNT(DISTINCT p.playerId) AS uniquePlayersCleared,
      COALESCE(SUM(CASE WHEN p.isWorldsFirst = 1 THEN 1 ELSE 0 END), 0) AS worldsFirstsOnLevels,
      COALESCE(SUM(
        j.earlyDouble + j.earlySingle + j.ePerfect + j.perfect + j.lPerfect + j.lateSingle + j.lateDouble
      ), 0) AS totalTilesPlayedOnLevels
    FROM passes p
    INNER JOIN judgements j ON j.id = p.id
    INNER JOIN levels l ON l.id = p.levelId AND l.isDeleted = 0
    WHERE IFNULL(p.isDeleted, 0) = 0
      AND IFNULL(p.isHidden, 0) = 0
      AND p.levelId IN (
        SELECT DISTINCT lc.levelId
        FROM level_credits lc
        INNER JOIN levels lv ON lv.id = lc.levelId AND lv.isDeleted = 0
        WHERE lc.creatorId = :creatorId
      )
  `;

  const rerateSql = `
    SELECT COUNT(*) AS c
    FROM level_rerate_histories lh
    WHERE lh.levelId IN (
      SELECT DISTINCT lc.levelId
      FROM level_credits lc
      INNER JOIN levels lv ON lv.id = lc.levelId AND lv.isDeleted = 0
      WHERE lc.creatorId = :creatorId
    )
  `;

  const curationSql = `
    SELECT COUNT(*) AS c
    FROM curations c
    WHERE c.assignedBy = (SELECT userId FROM creators WHERE id = :creatorId LIMIT 1)
  `;

  const aliasSql = `SELECT COUNT(*) AS c FROM creator_aliases WHERE creatorId = :creatorId`;
  const teamSql = `SELECT COUNT(*) AS c FROM team_members WHERE creatorId = :creatorId`;

  const [
    contentRows,
    creditsRows,
    diffRows,
    audienceRows,
    rerateRows,
    curationRows,
    aliasRows,
    teamRows,
  ] = await Promise.all([
    levelsSequelize.query(contentSql, {
      replacements: {creatorId},
      type: QueryTypes.SELECT,
    }) as Promise<Array<Record<string, unknown>>>,
    levelsSequelize.query(creditsSql, {
      replacements: {creatorId},
      type: QueryTypes.SELECT,
    }) as Promise<Array<Record<string, unknown>>>,
    levelsSequelize.query(diffSql, {
      replacements: {creatorId},
      type: QueryTypes.SELECT,
    }) as Promise<Array<Record<string, unknown>>>,
    passesSequelize.query(audienceSql, {
      replacements: {creatorId},
      type: QueryTypes.SELECT,
    }) as Promise<Array<Record<string, unknown>>>,
    levelsSequelize.query(rerateSql, {
      replacements: {creatorId},
      type: QueryTypes.SELECT,
    }) as Promise<Array<Record<string, unknown>>>,
    curationsSequelize.query(curationSql, {
      replacements: {creatorId},
      type: QueryTypes.SELECT,
    }) as Promise<Array<Record<string, unknown>>>,
    creditsSequelize.query(aliasSql, {
      replacements: {creatorId},
      type: QueryTypes.SELECT,
    }) as Promise<Array<Record<string, unknown>>>,
    creditsSequelize.query(teamSql, {
      replacements: {creatorId},
      type: QueryTypes.SELECT,
    }) as Promise<Array<Record<string, unknown>>>,
  ]);

  const c = contentRows[0] || {};
  const cr = creditsRows[0] || {};
  const aud = audienceRows[0] || {};

  const levelsByDifficulty: Record<string, number> = {};
  const levelsByDifficultyType = {...emptyClearsByDifficultyType()};
  for (const row of diffRows) {
    const diffId = String(Number(row.diffId) || 0);
    const cnt = Number(row.cnt) || 0;
    levelsByDifficulty[diffId] = (levelsByDifficulty[diffId] || 0) + cnt;
    mergeDifficultyTypeCounts(levelsByDifficultyType, row.diffType as string, cnt);
  }

  const curatedCount = Number((curationRows[0] as {c?: unknown})?.c) || 0;
  const rerateCount = Number((rerateRows[0] as {c?: unknown})?.c) || 0;

  return {
    identity: {
      aliasCount: Number((aliasRows[0] as {c?: unknown})?.c) || 0,
      teamsJoined: Number((teamRows[0] as {c?: unknown})?.c) || 0,
    },
    credits: {
      levelsCreditedDistinct: Number(cr.levelsCreditedDistinct) || 0,
      levelsAsCharter: Number(cr.levelsAsCharter) || 0,
      levelsAsVfxer: Number(cr.levelsAsVfxer) || 0,
      levelsAsCreator: Number(cr.levelsAsCreator) || 0,
      levelsAsTeamMember: Number(cr.levelsAsTeamMember) || 0,
      levelsOwned: Number(cr.levelsOwned) || 0,
    },
    content: {
      totalTilesMade: Number(c.totalTilesMade) || 0,
      totalLevelDurationMs: Number(c.totalLevelDurationMs) || 0,
      averageTilecount: Number(c.averageTilecount) || 0,
      averageLevelLengthMs: Number(c.averageLevelLengthMs) || 0,
      averageBpm: Number(c.averageBpm) || 0,
      totalClearsOnLevels: Number(c.totalClearsOnLevels) || 0,
      totalLikesOnLevels: Number(c.totalLikesOnLevels) || 0,
      totalDownloadsOnLevels: Number(c.totalDownloadsOnLevels) || 0,
    },
    audience: {
      uniquePlayersCleared: Number(aud.uniquePlayersCleared) || 0,
      worldsFirstsOnLevels: Number(aud.worldsFirstsOnLevels) || 0,
      totalTilesPlayedOnLevels: Number(aud.totalTilesPlayedOnLevels) || 0,
    },
    curation: {
      curatedLevels: curatedCount,
      rerateCount,
    },
    timeline: {
      firstLevelAt: toIso(c.firstLevelAt),
      latestLevelAt: toIso(c.latestLevelAt),
    },
    levelsByDifficulty,
    levelsByDifficultyType: {...levelsByDifficultyType},
  };
}

/**
 * Count distinct levels (per curation type) where the creator is credited.
 * Chart-style tags (names starting with C or O) only count if this creator is
 * a charter on that level; VFX tiers (V…) only if they are a vfxer. H…
 * (historical) and any other naming pattern keep the previous rule (any
 * credit on the level).
 */
const creatorCurationTypeCountsSql = `
  SELECT cct.typeId AS typeId, COUNT(DISTINCT c.levelId) AS cnt
  FROM curation_curation_types cct
  INNER JOIN curations c ON c.id = cct.curationId
  INNER JOIN levels l ON l.id = c.levelId AND IFNULL(l.isDeleted, 0) = 0
  INNER JOIN curation_types ct ON ct.id = cct.typeId
  WHERE c.levelId IN (
    SELECT lc.levelId FROM level_credits lc
    WHERE lc.creatorId = :creatorId
  )
  AND (
    (
      TRIM(ct.name) REGEXP '^[CcOo][0-9]*$'
      AND EXISTS (
        SELECT 1 FROM level_credits lc2
        WHERE lc2.levelId = c.levelId
          AND lc2.creatorId = :creatorId
          AND lc2.role = 'charter'
      )
    )
    OR (
      TRIM(ct.name) REGEXP '^[Vv][0-9]*$'
      AND EXISTS (
        SELECT 1 FROM level_credits lc2
        WHERE lc2.levelId = c.levelId
          AND lc2.creatorId = :creatorId
          AND lc2.role = 'vfxer'
      )
    )
    OR TRIM(ct.name) REGEXP '^[Hh][0-9]*$'
    OR (
      TRIM(ct.name) NOT REGEXP '^[CcOo][0-9]*$'
      AND TRIM(ct.name) NOT REGEXP '^[Vv][0-9]*$'
      AND TRIM(ct.name) NOT REGEXP '^[Hh][0-9]*$'
    )
  )
  GROUP BY cct.typeId
`;

/**
 * Distinct levels (credited to this creator) that carry each curation type tag.
 */
export async function computeCreatorCurationTypeCounts(
  creatorId: number,
): Promise<Record<string, number>> {
  if (!Number.isFinite(creatorId) || creatorId <= 0) return {};
  const rows = (await sequelize.query(creatorCurationTypeCountsSql, {
    replacements: {creatorId},
    type: QueryTypes.SELECT,
  })) as Array<{typeId: unknown; cnt: unknown}>;
  const out: Record<string, number> = {};
  for (const row of rows) {
    const id = Number(row.typeId);
    const cnt = Number(row.cnt) || 0;
    if (Number.isFinite(id)) out[String(id)] = cnt;
  }
  return out;
}
