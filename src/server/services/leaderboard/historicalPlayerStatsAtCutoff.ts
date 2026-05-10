import sequelize from '@/config/db.js';
import { QueryTypes } from 'sequelize';

/**
 * Recomputes the same aggregates as {@link playerStatsQuery} using only passes with
 * `vidUploadTime <= :cutoff`, mirroring `player_pass_summary` shape via PassesSnapshot.
 *
 * `isBanned` is taken from the **current** `players` row (v1 limitation — not time-traveled).
 *
 * Ranks use MySQL `RANK() ... ORDER BY score DESC`, matching Elasticsearch `count(gt)` semantics
 * (competition ranking: ties share rank; next rank skips).
 */
export const historicalPlayerStatsAtCutoffSql = `
  WITH PassesSnapshot AS (
    SELECT
      p.id,
      p.playerId,
      p.levelId,
      p.scoreV2,
      p.accuracy,
      p.isWorldsFirst,
      p.is12K,
      l.diffId,
      COALESCE(NULLIF(l.baseScore, 0), d.baseScore, 0) AS baseScore,
      d.sortOrder,
      d.type,
      d.name,
      CASE
        WHEN l.isExternallyAvailable = true THEN 'Available (Flag)'
        WHEN l.dlLink IS NOT NULL AND l.dlLink != '' THEN 'Available (DL Link)'
        WHEN l.workshopLink IS NOT NULL AND l.workshopLink != '' THEN 'Available (Workshop)'
        ELSE 'Not Available'
      END COLLATE utf8mb4_0900_ai_ci AS availability_status
    FROM passes p
    INNER JOIN levels l ON p.levelId = l.id
    INNER JOIN difficulties d ON l.diffId = d.id
    WHERE p.isDeleted = false
      AND l.isDeleted = false
      AND p.isHidden = false
      AND p.isDuplicate = false
      AND p.vidUploadTime <= :cutoff
  ),
  PassesData AS (
    SELECT
      p.playerId,
      p.levelId,
      p.availability_status,
      MAX(p.isWorldsFirst) AS isWorldsFirst,
      MAX(p.is12K) AS is12K,
      MAX(p.accuracy) AS accuracy,
      MAX(p.scoreV2) AS scoreV2
    FROM PassesSnapshot p
    GROUP BY p.playerId, p.levelId
  ),
  GeneralPassesData AS (
    SELECT
      p.playerId,
      p.levelId,
      p.availability_status,
      SUM(p.scoreV2) AS levelScore
    FROM PassesSnapshot p
    GROUP BY p.playerId, p.levelId
  ),
  RankedScores AS (
    SELECT
      p.playerId,
      p.scoreV2,
      ROW_NUMBER() OVER (PARTITION BY p.playerId ORDER BY p.scoreV2 DESC) AS rank_num
    FROM PassesData p
    WHERE p.availability_status != 'Not Available'
  ),
  RankedScoreCalc AS (
    SELECT
      rs.playerId,
      SUM(rs.scoreV2 * POW(0.9, rs.rank_num - 1)) AS rankedScore
    FROM RankedScores rs
    WHERE rs.rank_num <= 20
    GROUP BY rs.playerId
  ),
  GeneralScoreCalc AS (
    SELECT
      p.playerId,
      SUM(p.levelScore) AS generalScore
    FROM GeneralPassesData p
    GROUP BY p.playerId
  ),
  PPScoreCalc AS (
    SELECT
      p.playerId,
      SUM(p.scoreV2) AS ppScore
    FROM PassesData p
    WHERE p.accuracy = 1.0
    GROUP BY p.playerId
  ),
  WFScoreCalc AS (
    SELECT
      p.playerId,
      SUM(ps.baseScore) AS wfScore
    FROM PassesData p
    INNER JOIN PassesSnapshot ps ON p.playerId = ps.playerId AND p.levelId = ps.levelId
    WHERE p.isWorldsFirst = true
    GROUP BY p.playerId
  ),
  Score12KCalc AS (
    SELECT
      ranked.playerId,
      SUM(ranked.scoreV2 * POW(0.9, ranked.rank_num - 1)) AS score12K
    FROM (
      SELECT
        p.playerId,
        p.scoreV2,
        ROW_NUMBER() OVER (PARTITION BY p.playerId ORDER BY p.scoreV2 DESC) AS rank_num
      FROM PassesData p
      WHERE p.is12K = true
    ) ranked
    WHERE ranked.rank_num <= 20
    GROUP BY ranked.playerId
  ),
  AverageXaccCalc AS (
    SELECT
      ranked.playerId,
      AVG(ranked.accuracy) AS averageXacc
    FROM (
      SELECT
        p.playerId,
        p.accuracy,
        ROW_NUMBER() OVER (PARTITION BY p.playerId ORDER BY p.scoreV2 DESC) AS rank_num
      FROM PassesData p
    ) ranked
    WHERE ranked.rank_num <= 20
    GROUP BY ranked.playerId
  ),
  UniversalPassCountCalc AS (
    SELECT
      p.playerId,
      COUNT(DISTINCT p.levelId) AS universalPassCount
    FROM PassesData p
    INNER JOIN PassesSnapshot ps ON p.playerId = ps.playerId AND p.levelId = ps.levelId
    WHERE ps.name LIKE 'U%'
      AND ps.type = 'PGU'
    GROUP BY p.playerId
  ),
  WorldsFirstCountCalc AS (
    SELECT
      p.playerId,
      COUNT(*) AS worldsFirstCount
    FROM PassesData p
    WHERE p.isWorldsFirst = true
    GROUP BY p.playerId
  ),
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
      INNER JOIN PassesSnapshot ps ON p.playerId = ps.playerId AND p.levelId = ps.levelId
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
      INNER JOIN PassesSnapshot ps ON p.playerId = ps.playerId AND p.levelId = ps.levelId
      WHERE ps.type = 'PGU'
        AND p.is12K = true
    ) ranked
    WHERE rn = 1
  ),
  TotalPassesCalc AS (
    SELECT
      p.playerId,
      COUNT(*) AS totalPasses
    FROM PassesData p
    GROUP BY p.playerId
  ),
  StatsRows AS (
    SELECT
      p.playerId AS id,
      COALESCE(rs.rankedScore, 0) AS rankedScore,
      COALESCE(gs.generalScore, 0) AS generalScore,
      COALESCE(tpc.totalPasses, 0) AS totalPasses
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
  ),
  Eligible AS (
    SELECT
      s.id,
      s.rankedScore,
      s.generalScore,
      s.totalPasses
    FROM StatsRows s
    INNER JOIN players pl ON pl.id = s.id AND pl.isBanned = false
    WHERE s.totalPasses > 0
  )
  SELECT
    e.id AS playerId,
    e.rankedScore,
    e.generalScore,
    RANK() OVER (ORDER BY e.rankedScore DESC) AS rankedScoreRank,
    RANK() OVER (ORDER BY e.generalScore DESC) AS generalScoreRank
  FROM Eligible e
`;

export interface HistoricalPlayerRankRow {
  playerId: number;
  rankedScore: number;
  generalScore: number;
  rankedScoreRank: number;
  generalScoreRank: number;
}

export async function fetchHistoricalLeaderboardRanksAtCutoff(
  cutoff: Date,
): Promise<HistoricalPlayerRankRow[]> {
  const rows = (await sequelize.query(historicalPlayerStatsAtCutoffSql, {
    replacements: { cutoff },
    type: QueryTypes.SELECT,
  })) as HistoricalPlayerRankRow[];

  return rows.map((r) => ({
    playerId: Number(r.playerId),
    rankedScore: Number(r.rankedScore),
    generalScore: Number(r.generalScore),
    rankedScoreRank: Number(r.rankedScoreRank),
    generalScoreRank: Number(r.generalScoreRank),
  }));
}

export type RankPair = { rankedScoreRank: number; generalScoreRank: number };

/** Off-board sentinel (not indexed in ES for leaderboard ranks). */
export const OFF_LEADERBOARD_RANK = -1;

export function rankPairKey(p: RankPair): string {
  return `${p.rankedScoreRank},${p.generalScoreRank}`;
}

/**
 * Compare consecutive daily snapshots; emit rows only when the vector changes or
 * eligibility flips (including falling off the board ➔ (-1,-1)).
 */
export function diffRankSnapshots(
  prev: Map<number, RankPair>,
  curr: Map<number, RankPair>,
): Array<{ playerId: number } & RankPair> {
  const out: Array<{ playerId: number } & RankPair> = [];
  const ids = new Set<number>([...prev.keys(), ...curr.keys()]);

  for (const playerId of ids) {
    const prevP = prev.get(playerId);
    const currP = curr.get(playerId);

    if (!currP) {
      if (
        prevP &&
        (prevP.rankedScoreRank !== OFF_LEADERBOARD_RANK || prevP.generalScoreRank !== OFF_LEADERBOARD_RANK)
      ) {
        out.push({
          playerId,
          rankedScoreRank: OFF_LEADERBOARD_RANK,
          generalScoreRank: OFF_LEADERBOARD_RANK,
        });
      }
      continue;
    }

    if (!prevP) {
      out.push({ playerId, ...currP });
      continue;
    }

    if (rankPairKey(prevP) !== rankPairKey(currP)) {
      out.push({ playerId, ...currP });
    }
  }

  return out;
}

export function rowsToRankMap(rows: HistoricalPlayerRankRow[]): Map<number, RankPair> {
  const m = new Map<number, RankPair>();
  for (const r of rows) {
    m.set(r.playerId, {
      rankedScoreRank: r.rankedScoreRank,
      generalScoreRank: r.generalScoreRank,
    });
  }
  return m;
}
