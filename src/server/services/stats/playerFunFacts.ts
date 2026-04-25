import {getSequelizeForModelGroup} from '@/config/db.js';
import {QueryTypes} from 'sequelize';
import type {PlayerFunFacts} from '@/server/interfaces/stats/funFacts.js';
import User from '@/models/auth/User.js';
import Player from '@/models/players/Player.js';
import {
  deriveJudgementRatios,
  emptyClearsByDifficultyType,
  mergeDifficultyTypeCounts,
} from '@/server/services/stats/funFactsShape.js';

const passesSequelize = getSequelizeForModelGroup('passes');
const authSequelize = getSequelizeForModelGroup('auth');
const packsSequelize = getSequelizeForModelGroup('packs');

function toIso(d: unknown): string | null {
  if (!d) return null;
  if (d instanceof Date && !Number.isNaN(d.getTime())) return d.toISOString();
  const t = new Date(String(d));
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

export async function computePlayerFunFacts(
  playerId: number,
  options: {includeHidden: boolean},
): Promise<PlayerFunFacts> {
  const empty: PlayerFunFacts = {
    counts: {
      totalPasses: 0,
      uniqueLevelsCleared: 0,
      worldsFirstCount: 0,
      clears12K: 0,
      clears16K: 0,
      clearsNoHoldTap: 0,
      duplicatePasses: 0,
      hiddenPasses: 0,
    },
    judgements: {
      totalTilesHit: 0,
      earlyDouble: 0,
      earlySingle: 0,
      ePerfect: 0,
      perfect: 0,
      lPerfect: 0,
      lateSingle: 0,
      lateDouble: 0,
      totalXacc: 0,
      earlyVsLateBias: 0,
    },
    levelsCleared: {
      totalTilecountCleared: 0,
      totalLevelLengthMs: 0,
      totalPlaytimeMs: 0,
      averageBpm: 0,
      totalScoreV2: 0,
    },
    extremes: {
      firstPassAt: null,
      latestPassAt: null,
      bestAccuracy: null,
      worstAccuracy: null,
      topSpeed: null,
      highestTilecountCleared: null,
      longestLevelMs: null,
      highestBpmCleared: null,
    },
    activity: {
      accountAgeDays: 0,
      daysActive: 0,
      passesLast30Days: 0,
      uniqueLevelsLiked: 0,
      packsOwned: 0,
      packsFavorited: 0,
    },
    clearsByDifficulty: {},
    clearsByDifficultyNoDupes: {},
    worldsFirstByDifficulty: {},
    clearsByDifficultyType: {...emptyClearsByDifficultyType()},
  };

  if (!Number.isFinite(playerId) || playerId <= 0) return empty;

  const includeHidden = options.includeHidden ? 1 : 0;

  const mainSql = `
    SELECT
      COALESCE(COUNT(*), 0) AS totalPasses,
      COALESCE(COUNT(DISTINCT p.levelId), 0) AS uniqueLevelsCleared,
      COALESCE(SUM(CASE WHEN p.isWorldsFirst = 1 THEN 1 ELSE 0 END), 0) AS worldsFirstCount,
      COALESCE(SUM(CASE WHEN p.is12K = 1 THEN 1 ELSE 0 END), 0) AS clears12K,
      COALESCE(SUM(CASE WHEN p.is16K = 1 THEN 1 ELSE 0 END), 0) AS clears16K,
      COALESCE(SUM(CASE WHEN p.isNoHoldTap = 1 THEN 1 ELSE 0 END), 0) AS clearsNoHoldTap,
      COALESCE(SUM(CASE WHEN p.isDuplicate = 1 THEN 1 ELSE 0 END), 0) AS duplicatePasses,
      COALESCE(SUM(CASE WHEN IFNULL(p.isHidden, 0) = 1 THEN 1 ELSE 0 END), 0) AS hiddenPasses,
      COALESCE(SUM(j.earlyDouble), 0) AS earlyDouble,
      COALESCE(SUM(j.earlySingle), 0) AS earlySingle,
      COALESCE(SUM(j.ePerfect), 0) AS ePerfect,
      COALESCE(SUM(j.perfect), 0) AS perfect,
      COALESCE(SUM(j.lPerfect), 0) AS lPerfect,
      COALESCE(SUM(j.lateSingle), 0) AS lateSingle,
      COALESCE(SUM(j.lateDouble), 0) AS lateDouble,
      COALESCE(SUM(
        j.earlyDouble + j.earlySingle + j.ePerfect + j.perfect + j.lPerfect + j.lateSingle + j.lateDouble
      ), 0) AS totalTilesHit,
      COALESCE(SUM(IFNULL(l.tilecount, 0)), 0) AS totalTilecountCleared,
      COALESCE(SUM(IFNULL(l.levelLengthInMs, 0)), 0) AS totalLevelLengthMs,
      COALESCE(SUM(
        CASE
          WHEN p.speed IS NOT NULL AND p.speed > 0 AND l.levelLengthInMs IS NOT NULL
            THEN l.levelLengthInMs / p.speed
          ELSE 0
        END
      ), 0) AS totalPlaytimeMs,
      COALESCE(AVG(l.bpm), 0) AS averageBpm,
      COALESCE(SUM(IFNULL(p.scoreV2, 0)), 0) AS totalScoreV2,
      MIN(p.vidUploadTime) AS firstPassAt,
      MAX(p.vidUploadTime) AS latestPassAt,
      MAX(p.accuracy) AS bestAccuracy,
      MIN(CASE WHEN p.accuracy IS NOT NULL THEN p.accuracy END) AS worstAccuracy,
      MAX(p.speed) AS topSpeed,
      MAX(l.tilecount) AS highestTilecountCleared,
      MAX(l.levelLengthInMs) AS longestLevelMs,
      MAX(l.bpm) AS highestBpmCleared,
      COALESCE(COUNT(DISTINCT DATE(p.vidUploadTime)), 0) AS daysActive,
      COALESCE(SUM(CASE WHEN p.createdAt >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY) THEN 1 ELSE 0 END), 0) AS passesLast30Days,
      (SELECT COALESCE(DATEDIFF(UTC_TIMESTAMP(), pl.createdAt), 0) FROM players pl WHERE pl.id = :playerId LIMIT 1) AS accountAgeDays
    FROM passes p
    INNER JOIN judgements j ON j.id = p.id
    INNER JOIN levels l ON l.id = p.levelId AND l.isDeleted = 0
    WHERE p.playerId = :playerId
      AND IFNULL(p.isDeleted, 0) = 0
      AND (:includeHidden = 1 OR IFNULL(p.isHidden, 0) = 0)
  `;

  const extremesSourceSql = `
    SELECT
      (
        SELECT p2.id
        FROM passes p2
        INNER JOIN levels l2 ON l2.id = p2.levelId AND l2.isDeleted = 0
        WHERE p2.playerId = :playerId
          AND IFNULL(p2.isDeleted, 0) = 0
          AND (:includeHidden = 1 OR IFNULL(p2.isHidden, 0) = 0)
        ORDER BY p2.vidUploadTime ASC, p2.id ASC
        LIMIT 1
      ) AS firstPassAtPassId,
      (
        SELECT p2.id
        FROM passes p2
        INNER JOIN levels l2 ON l2.id = p2.levelId AND l2.isDeleted = 0
        WHERE p2.playerId = :playerId
          AND IFNULL(p2.isDeleted, 0) = 0
          AND (:includeHidden = 1 OR IFNULL(p2.isHidden, 0) = 0)
        ORDER BY p2.vidUploadTime DESC, p2.id DESC
        LIMIT 1
      ) AS latestPassAtPassId,
      (
        SELECT p2.id
        FROM passes p2
        INNER JOIN levels l2 ON l2.id = p2.levelId AND l2.isDeleted = 0
        WHERE p2.playerId = :playerId
          AND IFNULL(p2.isDeleted, 0) = 0
          AND (:includeHidden = 1 OR IFNULL(p2.isHidden, 0) = 0)
          AND p2.accuracy IS NOT NULL
        ORDER BY p2.accuracy DESC, p2.id DESC
        LIMIT 1
      ) AS bestAccuracyPassId,
      (
        SELECT p2.id
        FROM passes p2
        INNER JOIN levels l2 ON l2.id = p2.levelId AND l2.isDeleted = 0
        WHERE p2.playerId = :playerId
          AND IFNULL(p2.isDeleted, 0) = 0
          AND (:includeHidden = 1 OR IFNULL(p2.isHidden, 0) = 0)
          AND p2.accuracy IS NOT NULL
        ORDER BY p2.accuracy ASC, p2.id DESC
        LIMIT 1
      ) AS worstAccuracyPassId,
      (
        SELECT p2.id
        FROM passes p2
        INNER JOIN levels l2 ON l2.id = p2.levelId AND l2.isDeleted = 0
        WHERE p2.playerId = :playerId
          AND IFNULL(p2.isDeleted, 0) = 0
          AND (:includeHidden = 1 OR IFNULL(p2.isHidden, 0) = 0)
          AND p2.speed IS NOT NULL
          AND p2.speed > 0
        ORDER BY p2.speed DESC, p2.id DESC
        LIMIT 1
      ) AS topSpeedPassId,
      (
        SELECT p2.id
        FROM passes p2
        INNER JOIN levels l2 ON l2.id = p2.levelId AND l2.isDeleted = 0
        WHERE p2.playerId = :playerId
          AND IFNULL(p2.isDeleted, 0) = 0
          AND (:includeHidden = 1 OR IFNULL(p2.isHidden, 0) = 0)
        ORDER BY IFNULL(l2.tilecount, 0) DESC, p2.id DESC
        LIMIT 1
      ) AS highestTilecountClearedPassId,
      (
        SELECT p2.id
        FROM passes p2
        INNER JOIN levels l2 ON l2.id = p2.levelId AND l2.isDeleted = 0
        WHERE p2.playerId = :playerId
          AND IFNULL(p2.isDeleted, 0) = 0
          AND (:includeHidden = 1 OR IFNULL(p2.isHidden, 0) = 0)
        ORDER BY IFNULL(l2.levelLengthInMs, 0) DESC, p2.id DESC
        LIMIT 1
      ) AS longestLevelMsPassId,
      (
        SELECT p2.id
        FROM passes p2
        INNER JOIN levels l2 ON l2.id = p2.levelId AND l2.isDeleted = 0
        WHERE p2.playerId = :playerId
          AND IFNULL(p2.isDeleted, 0) = 0
          AND (:includeHidden = 1 OR IFNULL(p2.isHidden, 0) = 0)
        ORDER BY IFNULL(l2.bpm, 0) DESC, p2.id DESC
        LIMIT 1
      ) AS highestBpmClearedPassId
  `;

  // `clearsByDifficulty`: raw pass count per difficulty.
  // `clearsByDifficultyNoDupes`: one row per (player, level) — same rule as
  // `PlayerStatsService.getEnrichedPlayer` uniquePasses (best scoreV2 wins).
  // The `isDuplicate` column means “duplicate of another *level*”, not replay
  // clears on the same chart, so filtering on it alone left no-dupes == raw.
  const diffSql = `
    WITH ranked AS (
      SELECT
        l.diffId AS diffId,
        d.type AS diffType,
        IFNULL(p.isWorldsFirst, 0) AS is_wf,
        ROW_NUMBER() OVER (
          PARTITION BY p.playerId, p.levelId
          ORDER BY IFNULL(p.scoreV2, 0) DESC, p.id DESC
        ) AS rn_level
      FROM passes p
      INNER JOIN levels l ON l.id = p.levelId AND IFNULL(l.isDeleted, 0) = 0
      INNER JOIN difficulties d ON d.id = l.diffId
      WHERE p.playerId = :playerId
        AND IFNULL(p.isDeleted, 0) = 0
        AND (:includeHidden = 1 OR IFNULL(p.isHidden, 0) = 0)
    )
    SELECT
      diffId,
      diffType,
      COUNT(*) AS cnt,
      COALESCE(SUM(CASE WHEN rn_level = 1 THEN 1 ELSE 0 END), 0) AS cntNoDupes,
      COALESCE(SUM(CASE WHEN is_wf = 1 THEN 1 ELSE 0 END), 0) AS cntWf
    FROM ranked
    GROUP BY diffId, diffType
  `;

  const [mainRows, diffRows, sourceRows, playerRow, userRow] = await Promise.all([
    passesSequelize.query(mainSql, {
      replacements: {playerId, includeHidden},
      type: QueryTypes.SELECT,
    }) as Promise<Array<Record<string, unknown>>>,
    passesSequelize.query(diffSql, {
      replacements: {playerId, includeHidden},
      type: QueryTypes.SELECT,
    }) as Promise<Array<Record<string, unknown>>>,
    passesSequelize.query(extremesSourceSql, {
      replacements: {playerId, includeHidden},
      type: QueryTypes.SELECT,
    }) as Promise<Array<Record<string, unknown>>>,
    Player.findByPk(playerId, {attributes: ['createdAt']}),
    User.findOne({where: {playerId}, attributes: ['id']}),
  ]);

  const m = mainRows[0] || {};
  const src = sourceRows[0] || {};
  const totalTilesHit = Number(m.totalTilesHit) || 0;
  const earlyDouble = Number(m.earlyDouble) || 0;
  const earlySingle = Number(m.earlySingle) || 0;
  const perfect = Number(m.perfect) || 0;
  const lateSingle = Number(m.lateSingle) || 0;
  const lateDouble = Number(m.lateDouble) || 0;
  const ratios = deriveJudgementRatios({
    totalTilesHit,
    perfect,
    earlyDouble,
    earlySingle,
    lateSingle,
    lateDouble,
  });

  let accountAgeDays = Number(m.accountAgeDays) || 0;
  if (!accountAgeDays && playerRow?.createdAt) {
    const ms = Date.now() - new Date(playerRow.createdAt).getTime();
    accountAgeDays = Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
  }

  const clearsByDifficulty: Record<string, number> = {};
  const clearsByDifficultyNoDupes: Record<string, number> = {};
  const worldsFirstByDifficulty: Record<string, number> = {};
  const clearsByDifficultyType = {...emptyClearsByDifficultyType()};
  for (const row of diffRows) {
    const diffId = String(Number(row.diffId) || 0);
    const cnt = Number(row.cnt) || 0;
    const cntNoDupes = Number(row.cntNoDupes) || 0;
    const cntWf = Number(row.cntWf) || 0;
    clearsByDifficulty[diffId] = (clearsByDifficulty[diffId] || 0) + cnt;
    clearsByDifficultyNoDupes[diffId] =
      (clearsByDifficultyNoDupes[diffId] || 0) + cntNoDupes;
    if (cntWf > 0) {
      worldsFirstByDifficulty[diffId] =
        (worldsFirstByDifficulty[diffId] || 0) + cntWf;
    }
    mergeDifficultyTypeCounts(clearsByDifficultyType, row.diffType as string, cnt);
  }

  let uniqueLevelsLiked = 0;
  let packsOwned = 0;
  let packsFavorited = 0;
  if (userRow?.id) {
    const uid = userRow.id;
    const [likesRows, ownedRows, favRows] = await Promise.all([
      authSequelize.query(
        `SELECT COUNT(*) AS c FROM level_likes WHERE userId = :uid`,
        {replacements: {uid}, type: QueryTypes.SELECT},
      ) as Promise<Array<{c: number}>>,
      packsSequelize.query(
        `SELECT COUNT(*) AS c FROM level_packs WHERE ownerId = :uid`,
        {replacements: {uid}, type: QueryTypes.SELECT},
      ) as Promise<Array<{c: number}>>,
      packsSequelize.query(
        `SELECT COUNT(*) AS c FROM pack_favorites WHERE userId = :uid`,
        {replacements: {uid}, type: QueryTypes.SELECT},
      ) as Promise<Array<{c: number}>>,
    ]);
    uniqueLevelsLiked = Number((likesRows[0] as {c?: unknown})?.c) || 0;
    packsOwned = Number((ownedRows[0] as {c?: unknown})?.c) || 0;
    packsFavorited = Number((favRows[0] as {c?: unknown})?.c) || 0;
  }

  return {
    counts: {
      totalPasses: Number(m.totalPasses) || 0,
      uniqueLevelsCleared: Number(m.uniqueLevelsCleared) || 0,
      worldsFirstCount: Number(m.worldsFirstCount) || 0,
      clears12K: Number(m.clears12K) || 0,
      clears16K: Number(m.clears16K) || 0,
      clearsNoHoldTap: Number(m.clearsNoHoldTap) || 0,
      duplicatePasses: Number(m.duplicatePasses) || 0,
      hiddenPasses: Number(m.hiddenPasses) || 0,
    },
    judgements: {
      totalTilesHit,
      earlyDouble,
      earlySingle,
      ePerfect: Number(m.ePerfect) || 0,
      perfect,
      lPerfect: Number(m.lPerfect) || 0,
      lateSingle,
      lateDouble,
      totalXacc: ratios.totalXacc,
      earlyVsLateBias: ratios.earlyVsLateBias,
    },
    levelsCleared: {
      totalTilecountCleared: Number(m.totalTilecountCleared) || 0,
      totalLevelLengthMs: Number(m.totalLevelLengthMs) || 0,
      totalPlaytimeMs: Number(m.totalPlaytimeMs) || 0,
      averageBpm: Number(m.averageBpm) || 0,
      totalScoreV2: Number(m.totalScoreV2) || 0,
    },
    extremes: {
      firstPassAt: toIso(m.firstPassAt),
      firstPassAtPassId: src.firstPassAtPassId != null ? Number(src.firstPassAtPassId) : null,
      latestPassAt: toIso(m.latestPassAt),
      latestPassAtPassId: src.latestPassAtPassId != null ? Number(src.latestPassAtPassId) : null,
      bestAccuracy: m.bestAccuracy != null ? Number(m.bestAccuracy) : null,
      bestAccuracyPassId: src.bestAccuracyPassId != null ? Number(src.bestAccuracyPassId) : null,
      worstAccuracy: m.worstAccuracy != null ? Number(m.worstAccuracy) : null,
      worstAccuracyPassId: src.worstAccuracyPassId != null ? Number(src.worstAccuracyPassId) : null,
      topSpeed: m.topSpeed != null ? Number(m.topSpeed) : null,
      topSpeedPassId: src.topSpeedPassId != null ? Number(src.topSpeedPassId) : null,
      highestTilecountCleared:
        m.highestTilecountCleared != null ? Number(m.highestTilecountCleared) : null,
      highestTilecountClearedPassId:
        src.highestTilecountClearedPassId != null ? Number(src.highestTilecountClearedPassId) : null,
      longestLevelMs: m.longestLevelMs != null ? Number(m.longestLevelMs) : null,
      longestLevelMsPassId: src.longestLevelMsPassId != null ? Number(src.longestLevelMsPassId) : null,
      highestBpmCleared: m.highestBpmCleared != null ? Number(m.highestBpmCleared) : null,
      highestBpmClearedPassId: src.highestBpmClearedPassId != null ? Number(src.highestBpmClearedPassId) : null,
    },
    activity: {
      accountAgeDays,
      daysActive: Number(m.daysActive) || 0,
      passesLast30Days: Number(m.passesLast30Days) || 0,
      uniqueLevelsLiked,
      packsOwned,
      packsFavorited,
    },
    clearsByDifficulty,
    clearsByDifficultyNoDupes,
    worldsFirstByDifficulty,
    clearsByDifficultyType: {...clearsByDifficultyType},
  };
}
