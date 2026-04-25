import sequelize from '@/config/db.js';
import { QueryTypes } from 'sequelize';

/**
 * Shared SQL for computing derived creator statistics from `level_credits` joined with
 * `levels` (so chart-likes/clears mirror the denormalized counters on the level row).
 *
 * Consumed by:
 * - ElasticsearchService creator indexer (live source of truth — stats stored in ES creators index)
 * - CreatorStatsService (read-on-demand for the creator profile endpoint)
 *
 * Counters returned per creator:
 *   - chartsCharted      — # of (charter-role)  level credits
 *   - chartsVfxed        — # of (vfxer-role)    level credits
 *   - chartsTeamed       — distinct levels with `levels.teamId` set where this creator has a
 *                          charter/vfx credit and a matching `team_members` row for that team
 *   - chartsTotal        — # of distinct levels the creator is credited on
 *   - totalChartClears   — SUM(levels.clears)   over those distinct levels
 *   - totalChartLikes    — SUM(levels.likes)    over those distinct levels
 *
 * Excludes deleted levels so the surfaced stats match what users can actually browse.
 *
 * Bind params:
 *   :creatorIds — list of integer creator IDs (required, non-empty)
 */
export const creatorStatsQuery = `
  WITH CreditedLevels AS (
    SELECT
      lc.creatorId,
      lc.levelId,
      lc.role,
      l.clears,
      l.likes
    FROM level_credits lc
    JOIN levels l ON l.id = lc.levelId
    WHERE lc.creatorId IN (:creatorIds)
      AND l.isDeleted = 0
      AND lc.role IN ('charter', 'vfxer')
  ),
  RoleCounts AS (
    SELECT
      cl.creatorId,
      SUM(CASE WHEN cl.role = 'charter' THEN 1 ELSE 0 END) AS chartsCharted,
      SUM(CASE WHEN cl.role = 'vfxer' THEN 1 ELSE 0 END) AS chartsVfxed
    FROM CreditedLevels cl
    GROUP BY cl.creatorId
  ),
  TeamLevelCounts AS (
    SELECT
      lc.creatorId,
      COUNT(DISTINCT lc.levelId) AS chartsTeamed
    FROM level_credits lc
    JOIN levels l ON l.id = lc.levelId
      AND l.isDeleted = 0
      AND l.teamId IS NOT NULL
    INNER JOIN team_members tm ON tm.teamId = l.teamId AND tm.creatorId = lc.creatorId
    WHERE lc.creatorId IN (:creatorIds)
      AND lc.role IN ('charter', 'vfxer')
    GROUP BY lc.creatorId
  ),
  DistinctLevelTotals AS (
    SELECT
      x.creatorId,
      COUNT(*)        AS chartsTotal,
      SUM(x.clears)   AS totalChartClears,
      SUM(x.likes)    AS totalChartLikes
    FROM (
      SELECT
        cl.creatorId,
        cl.levelId,
        MAX(cl.clears) AS clears,
        MAX(cl.likes)  AS likes
      FROM CreditedLevels cl
      GROUP BY cl.creatorId, cl.levelId
    ) x
    GROUP BY x.creatorId
  )
  SELECT
    rc.creatorId AS id,
    COALESCE(rc.chartsCharted, 0)      AS chartsCharted,
    COALESCE(rc.chartsVfxed, 0)        AS chartsVfxed,
    COALESCE(tlc.chartsTeamed, 0)      AS chartsTeamed,
    COALESCE(dlt.chartsTotal, 0)       AS chartsTotal,
    COALESCE(dlt.totalChartClears, 0)  AS totalChartClears,
    COALESCE(dlt.totalChartLikes, 0)   AS totalChartLikes
  FROM RoleCounts rc
  LEFT JOIN DistinctLevelTotals dlt ON dlt.creatorId = rc.creatorId
  LEFT JOIN TeamLevelCounts tlc ON tlc.creatorId = rc.creatorId
`;

export interface CreatorStatsRow {
  id: number;
  chartsCharted: number;
  chartsVfxed: number;
  chartsTeamed: number;
  chartsTotal: number;
  totalChartClears: number;
  totalChartLikes: number;
}

export interface RunCreatorStatsQueryOptions {
  creatorIds: number[];
}

/**
 * Execute {@link creatorStatsQuery} for the given creator IDs.
 *
 * Returns one row per creator that currently has at least one credited level.
 * Creators with no credits get no row — treat as zero stats at the call site.
 */
export async function runCreatorStatsQuery(
  options: RunCreatorStatsQueryOptions,
): Promise<CreatorStatsRow[]> {
  const creatorIds = [...new Set(options.creatorIds)].filter(
    (id) => Number.isFinite(id) && id > 0,
  );
  if (creatorIds.length === 0) return [];

  const rows = (await sequelize.query(creatorStatsQuery, {
    replacements: { creatorIds },
    type: QueryTypes.SELECT,
  })) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: Number(row.id) || 0,
    chartsCharted: Number(row.chartsCharted) || 0,
    chartsVfxed: Number(row.chartsVfxed) || 0,
    chartsTeamed: Number(row.chartsTeamed) || 0,
    chartsTotal: Number(row.chartsTotal) || 0,
    totalChartClears: Number(row.totalChartClears) || 0,
    totalChartLikes: Number(row.totalChartLikes) || 0,
  }));
}
