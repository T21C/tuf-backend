import sequelize from '@/config/db.js';
import { QueryTypes } from 'sequelize';
import client, { playerIndexName } from '@/config/elasticsearch.js';
import { DEFAULT_LEADERBOARD_RANK_SCORING_VERSION } from '@/config/leaderboardRankHistory.js';
import { maskStellarPublicEsDoc } from '@/misc/utils/subscriptions/tufStellarPublicGate.js';
import { OFF_LEADERBOARD_RANK } from '@/server/services/leaderboard/historicalPlayerStatsAtCutoff.js';
import {
  utcDateOnlyFromDate,
  utcPreviousIsoDateOnly,
} from '@/server/services/leaderboard/leaderboardRankSnapshotUtils.js';
import { logger } from '@/server/services/core/LoggerService.js';

export type HistoricalLeaderboardMetric = 'rankedScore' | 'generalScore';

export interface HistoricalLeaderboardBounds {
  minDate: string | null;
  maxDate: string | null;
}

export interface HistoricalLeaderboardRow {
  playerId: number;
  rankedScoreRank: number;
  generalScoreRank: number;
  rank: number;
}

export interface HistoricalLeaderboardResult {
  count: number;
  results: HistoricalLeaderboardRow[];
  minDate: string | null;
  maxDate: string | null;
}

function toIsoDateOnly(raw: string | Date | null | undefined): string | null {
  if (raw == null) return null;
  if (raw instanceof Date) return utcDateOnlyFromDate(raw);
  return String(raw).slice(0, 10);
}

function metricRankColumn(metric: HistoricalLeaderboardMetric): 'rankedScoreRank' | 'generalScoreRank' {
  return metric === 'generalScore' ? 'generalScoreRank' : 'rankedScoreRank';
}

/**
 * Available date range for historical leaderboard (UTC DATEONLY).
 * `maxDate` is capped at yesterday (last completed daily snapshot).
 */
export async function fetchHistoricalLeaderboardBounds(
  scoringVersion: string = DEFAULT_LEADERBOARD_RANK_SCORING_VERSION,
): Promise<HistoricalLeaderboardBounds> {
  const rows = (await sequelize.query(
    `SELECT MIN(effectiveDay) AS minDate, MAX(effectiveDay) AS maxDate
     FROM player_leaderboard_rank_events
     WHERE scoringVersion = :scoringVersion`,
    {
      replacements: { scoringVersion },
      type: QueryTypes.SELECT,
    },
  )) as { minDate: string | Date | null; maxDate: string | Date | null }[];

  const minDate = toIsoDateOnly(rows?.[0]?.minDate);
  let maxDate = toIsoDateOnly(rows?.[0]?.maxDate);

  const yesterday = utcPreviousIsoDateOnly(utcDateOnlyFromDate(new Date()));
  if (maxDate && maxDate > yesterday) {
    maxDate = yesterday;
  }
  if (minDate && maxDate && minDate > maxDate) {
    return { minDate: null, maxDate: null };
  }

  return { minDate, maxDate };
}

/**
 * Reconstruct the rank-only leaderboard at end-of-day `date` by forward-filling
 * the latest `player_leaderboard_rank_events` row per player with effectiveDay <= date.
 */
export async function fetchHistoricalLeaderboardAtDate(options: {
  date: string;
  metric?: HistoricalLeaderboardMetric;
  order?: 'asc' | 'desc';
  query?: string;
  offset?: number;
  limit?: number;
  scoringVersion?: string;
}): Promise<HistoricalLeaderboardResult> {
  const scoringVersion = options.scoringVersion ?? DEFAULT_LEADERBOARD_RANK_SCORING_VERSION;
  const metric = options.metric === 'generalScore' ? 'generalScore' : 'rankedScore';
  const order = options.order === 'asc' ? 'ASC' : 'DESC';
  const offset = Math.max(0, Math.floor(Number(options.offset ?? 0)) || 0);
  const limit = Math.min(100, Math.max(1, Math.floor(Number(options.limit ?? 30)) || 30));
  const rankCol = metricRankColumn(metric);

  const bounds = await fetchHistoricalLeaderboardBounds(scoringVersion);
  if (!bounds.minDate || !bounds.maxDate) {
    return { count: 0, results: [], minDate: null, maxDate: null };
  }

  let date = options.date;
  if (date < bounds.minDate) date = bounds.minDate;
  if (date > bounds.maxDate) date = bounds.maxDate;

  const nameQuery = String(options.query ?? '').trim();
  const hasNameQuery = nameQuery.length > 0;
  const namePattern = hasNameQuery ? `%${nameQuery.replace(/[%_\\]/g, '\\$&')}%` : null;

  const nameJoin = hasNameQuery
    ? `INNER JOIN players pl ON pl.id = e.playerId AND pl.name LIKE :namePattern`
    : '';

  const baseFrom = `
    FROM player_leaderboard_rank_events e
    INNER JOIN (
      SELECT playerId, MAX(effectiveDay) AS maxDay
      FROM player_leaderboard_rank_events
      WHERE scoringVersion = :scoringVersion
        AND effectiveDay <= :date
      GROUP BY playerId
    ) latest ON latest.playerId = e.playerId AND latest.maxDay = e.effectiveDay
    ${nameJoin}
    WHERE e.scoringVersion = :scoringVersion
      AND e.${rankCol} != :offBoard
  `;

  const replacements: Record<string, unknown> = {
    scoringVersion,
    date,
    offBoard: OFF_LEADERBOARD_RANK,
    limit,
    offset,
  };
  if (hasNameQuery) {
    replacements.namePattern = namePattern;
  }

  const countRows = (await sequelize.query(
    `SELECT COUNT(*) AS cnt ${baseFrom}`,
    { replacements, type: QueryTypes.SELECT },
  )) as { cnt: number | string }[];

  const count = Number(countRows?.[0]?.cnt ?? 0);

  const rows = (await sequelize.query(
    `SELECT e.playerId, e.rankedScoreRank, e.generalScoreRank
     ${baseFrom}
     ORDER BY e.${rankCol} ${order}, e.playerId ASC
     LIMIT :limit OFFSET :offset`,
    { replacements, type: QueryTypes.SELECT },
  )) as { playerId: number; rankedScoreRank: number; generalScoreRank: number }[];

  const results: HistoricalLeaderboardRow[] = rows.map((r) => {
    const rankedScoreRank = Number(r.rankedScoreRank);
    const generalScoreRank = Number(r.generalScoreRank);
    const rank = metric === 'generalScore' ? generalScoreRank : rankedScoreRank;
    return {
      playerId: Number(r.playerId),
      rankedScoreRank,
      generalScoreRank,
      rank,
    };
  });

  return {
    count,
    results,
    minDate: bounds.minDate,
    maxDate: bounds.maxDate,
  };
}

const MGET_CHUNK = 100;

/**
 * Hydrate historical rank rows with current ES player documents (names, avatars, etc.).
 * Missing docs fall back to a minimal `{ id, name }` stub.
 */
export async function hydrateHistoricalLeaderboardPlayers(
  rows: HistoricalLeaderboardRow[],
): Promise<Record<string, unknown>[]> {
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.playerId);
  const docsById = new Map<number, Record<string, unknown>>();

  for (let i = 0; i < ids.length; i += MGET_CHUNK) {
    const chunk = ids.slice(i, i + MGET_CHUNK);
    try {
      const res = await client.mget({
        index: playerIndexName,
        ids: chunk.map((id) => String(id)),
      });
      for (const doc of res.docs) {
        if (!('found' in doc) || !doc.found || !doc._source) continue;
        const src = doc._source as Record<string, unknown>;
        const id =
          typeof src.id === 'number' ? src.id : parseInt(String(doc._id), 10);
        if (!Number.isFinite(id)) continue;
        const masked = maskStellarPublicEsDoc(src);
        if (masked) docsById.set(id, masked);
      }
    } catch (error) {
      logger.error('[historicalLeaderboard] ES mget failed', error);
    }
  }

  return rows.map((row) => {
    const doc = docsById.get(row.playerId);
    const base: Record<string, unknown> = doc
      ? { ...doc }
      : { id: row.playerId, name: `Player #${row.playerId}` };

    return {
      ...base,
      id: row.playerId,
      rank: row.rank,
      rankedScoreRank: row.rank,
      historicalRankedScoreRank: row.rankedScoreRank,
      historicalGeneralScoreRank: row.generalScoreRank,
    };
  });
}
