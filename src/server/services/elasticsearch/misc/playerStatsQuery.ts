import sequelize from '@/config/db.js';
import { QueryTypes } from 'sequelize';

/**
 * Shared SQL for computing derived player statistics from the `player_pass_summary` view.
 *
 * Consumed by:
 * - ElasticsearchService player indexer (live source of truth — stats stored in ES players index)
 * - Deprecated PlayerStatsService (read-only fallbacks during the migration window)
 *
 * Bind params:
 *   :playerIds         — list of integer player IDs (required)
 *   :excludedLevelIds  — list of level IDs to exclude, or NULL
 *   :excludedPassIds   — list of pass IDs to exclude, or NULL
 */
export const playerStatsQuery = `
  WITH PassesData AS (
    SELECT
      p.playerId,
      p.levelId,
      p.availability_status,
      MAX(p.isWorldsFirst) as isWorldsFirst,
      MAX(p.is12K) as is12K,
      MAX(p.accuracy) as accuracy,
      MAX(p.scoreV2) as scoreV2
    FROM player_pass_summary p
    WHERE p.playerId IN (:playerIds)
    AND (:excludedLevelIds IS NULL OR p.levelId NOT IN (:excludedLevelIds))
    AND (:excludedPassIds IS NULL OR p.id NOT IN (:excludedPassIds))
    GROUP BY p.playerId, p.levelId
  ),
  GeneralPassesData AS (
    SELECT
      p.playerId,
      p.levelId,
      p.availability_status,
      SUM(p.scoreV2) as levelScore
    FROM player_pass_summary p
    WHERE p.playerId IN (:playerIds)
    AND (:excludedLevelIds IS NULL OR p.levelId NOT IN (:excludedLevelIds))
    AND (:excludedPassIds IS NULL OR p.id NOT IN (:excludedPassIds))
    GROUP BY p.playerId, p.levelId
  ),
  RankedScores AS (
    SELECT
      p.playerId,
      p.scoreV2,
      ROW_NUMBER() OVER (PARTITION BY p.playerId ORDER BY p.scoreV2 DESC) as rank_num
    FROM PassesData p
    WHERE p.availability_status != 'Not Available'
  ),
  RankedScoreCalc AS (
    SELECT
      rs.playerId,
      SUM(rs.scoreV2 * POW(0.9, rs.rank_num - 1)) as rankedScore
    FROM RankedScores rs
    WHERE rs.rank_num <= 20
    GROUP BY rs.playerId
  ),
  GeneralScoreCalc AS (
    SELECT
      p.playerId,
      SUM(p.levelScore) as generalScore
    FROM GeneralPassesData p
    GROUP BY p.playerId
  ),
  PPScoreCalc AS (
    SELECT
      p.playerId,
      SUM(p.scoreV2) as ppScore
    FROM PassesData p
    WHERE p.accuracy = 1.0
    GROUP BY p.playerId
  ),
  WFScoreCalc AS (
    SELECT
      p.playerId,
      SUM(ps.baseScore) as wfScore
    FROM PassesData p
    JOIN player_pass_summary ps ON p.playerId = ps.playerId AND p.levelId = ps.levelId
    WHERE p.isWorldsFirst = true
    GROUP BY p.playerId
  ),
  Score12KCalc AS (
    SELECT
      ranked.playerId,
      SUM(ranked.scoreV2 * POW(0.9, ranked.rank_num - 1)) as score12K
    FROM (
      SELECT
        p.playerId,
        p.scoreV2,
        ROW_NUMBER() OVER (PARTITION BY p.playerId ORDER BY p.scoreV2 DESC) as rank_num
      FROM PassesData p
      WHERE p.is12K = true
    ) ranked
    WHERE ranked.rank_num <= 20
    GROUP BY ranked.playerId
  ),
  AverageXaccCalc AS (
    SELECT
      ranked.playerId,
      AVG(ranked.accuracy) as averageXacc
    FROM (
      SELECT
        p.playerId,
        p.accuracy,
        ROW_NUMBER() OVER (PARTITION BY p.playerId ORDER BY p.scoreV2 DESC) as rank_num
      FROM PassesData p
    ) ranked
    WHERE ranked.rank_num <= 20
    GROUP BY ranked.playerId
  ),
  UniversalPassCountCalc AS (
    SELECT
      p.playerId,
      COUNT(DISTINCT p.levelId) as universalPassCount
    FROM PassesData p
    JOIN player_pass_summary ps ON p.playerId = ps.playerId AND p.levelId = ps.levelId
    WHERE ps.name LIKE 'U%'
    AND ps.type = 'PGU'
    GROUP BY p.playerId
  ),
  WorldsFirstCountCalc AS (
    SELECT
      p.playerId,
      COUNT(*) as worldsFirstCount
    FROM PassesData p
    WHERE p.isWorldsFirst = true
    GROUP BY p.playerId
  ),
  /*
   * Resolve the actual Difficulty PK (ps.diffId from the view) by ranking each
   * player's PGU passes by sortOrder DESC and picking rank 1. Using sortOrder as
   * a stand-in for the PK is WRONG — sortOrder collides with SPECIAL difficulties
   * and would cause the indexer to denormalize the wrong Difficulty row.
   */
  TopDiffId AS (
    SELECT playerId, diffId
    FROM (
      SELECT
        p.playerId,
        ps.diffId,
        ROW_NUMBER() OVER (
          PARTITION BY p.playerId
          ORDER BY ps.sortOrder DESC, ps.diffId DESC
        ) AS rn
      FROM PassesData p
      JOIN player_pass_summary ps
        ON p.playerId = ps.playerId
       AND p.levelId = ps.levelId
      WHERE ps.type = 'PGU'
    ) ranked
    WHERE rn = 1
  ),
  TopDiff12kId AS (
    SELECT playerId, diffId
    FROM (
      SELECT
        p.playerId,
        ps.diffId,
        ROW_NUMBER() OVER (
          PARTITION BY p.playerId
          ORDER BY ps.sortOrder DESC, ps.diffId DESC
        ) AS rn
      FROM PassesData p
      JOIN player_pass_summary ps
        ON p.playerId = ps.playerId
       AND p.levelId = ps.levelId
      WHERE ps.type = 'PGU'
        AND p.is12K = true
    ) ranked
    WHERE rn = 1
  ),
  TotalPassesCalc AS (
    SELECT
      p.playerId,
      COUNT(*) as totalPasses
    FROM PassesData p
    GROUP BY p.playerId
  )
  SELECT
    p.playerId as id,
    COALESCE(rs.rankedScore, 0) as rankedScore,
    COALESCE(gs.generalScore, 0) as generalScore,
    COALESCE(ps.ppScore, 0) as ppScore,
    COALESCE(wfs.wfScore, 0) as wfScore,
    COALESCE(s12k.score12K, 0) as score12K,
    COALESCE(axc.averageXacc, 0) as averageXacc,
    COALESCE(upc.universalPassCount, 0) as universalPassCount,
    COALESCE(wfc.worldsFirstCount, 0) as worldsFirstCount,
    COALESCE(tdi.diffId, 0) as topDiffId,
    COALESCE(td12k.diffId, 0) as top12kDiffId,
    COALESCE(tpc.totalPasses, 0) as totalPasses,
    NOW() as lastUpdated,
    NOW() as createdAt,
    NOW() as updatedAt
  FROM (SELECT DISTINCT playerId FROM PassesData) p
  LEFT JOIN RankedScoreCalc rs ON rs.playerId = p.playerId
  LEFT JOIN GeneralScoreCalc gs ON gs.playerId = p.playerId
  LEFT JOIN PPScoreCalc ps ON ps.playerId = p.playerId
  LEFT JOIN WFScoreCalc wfs ON wfs.playerId = p.playerId
  LEFT JOIN Score12KCalc s12k ON s12k.playerId = p.playerId
  LEFT JOIN AverageXaccCalc axc ON axc.playerId = p.playerId
  LEFT JOIN UniversalPassCountCalc upc ON upc.playerId = p.playerId
  LEFT JOIN WorldsFirstCountCalc wfc ON wfc.playerId = p.playerId
  LEFT JOIN TopDiffId tdi ON tdi.playerId = p.playerId
  LEFT JOIN TopDiff12kId td12k ON td12k.playerId = p.playerId
  LEFT JOIN TotalPassesCalc tpc ON tpc.playerId = p.playerId
`;

export interface PlayerStatsRow {
  id: number;
  rankedScore: number;
  generalScore: number;
  ppScore: number;
  wfScore: number;
  score12K: number;
  averageXacc: number;
  universalPassCount: number;
  worldsFirstCount: number;
  topDiffId: number;
  top12kDiffId: number;
  totalPasses: number;
  lastUpdated: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface RunPlayerStatsQueryOptions {
  playerIds: number[];
  excludedLevelIds?: number[] | null;
  excludedPassIds?: number[] | null;
}

/**
 * Execute {@link playerStatsQuery} for the given player IDs.
 *
 * Returns one row per player that currently has at least one matching pass
 * in `player_pass_summary` (players with zero passes get no row — treat as zero stats).
 */
export async function runPlayerStatsQuery(
  options: RunPlayerStatsQueryOptions,
): Promise<PlayerStatsRow[]> {
  const playerIds = [...new Set(options.playerIds)].filter((id) => Number.isFinite(id));
  if (playerIds.length === 0) return [];

  const excludedLevelIds =
    options.excludedLevelIds && options.excludedLevelIds.length > 0
      ? options.excludedLevelIds
      : null;
  const excludedPassIds =
    options.excludedPassIds && options.excludedPassIds.length > 0
      ? options.excludedPassIds
      : null;

  const rows = (await sequelize.query(playerStatsQuery, {
    replacements: {
      playerIds,
      excludedLevelIds,
      excludedPassIds,
    },
    type: QueryTypes.SELECT,
  })) as PlayerStatsRow[];

  return rows;
}
