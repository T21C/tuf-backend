import { Op } from 'sequelize';
import {
  DEFAULT_LEADERBOARD_RANK_SCORING_VERSION,
  RANK_HISTORY_MAX_POINTS,
} from '@/config/leaderboardRankHistory.js';
import PlayerLeaderboardRankEvent from '@/models/players/PlayerLeaderboardRankEvent.js';
import { iterateUtcDateOnlyRange } from '@/server/services/leaderboard/leaderboardRankSnapshotUtils.js';
import { pickPeakRankHold, type PeakRankHold } from '@/server/services/leaderboard/peakRankHold.js';

export type RankHistoryPoint = {
  date: string;
  rankedScoreRank: number | null;
  generalScoreRank: number | null;
};

export type PeakRankedScore = PeakRankHold;

/**
 * All-time best ranked-score rank (lowest positive number) and the last UTC day
 * of the most recent hold at that rank (the day before the next rank-change event).
 * Ignores off-leaderboard (`-1`) and other non-positive ranks when choosing the peak.
 */
export async function getPeakRankedScoreRank(options: {
  playerId: number;
  scoringVersion?: string;
}): Promise<PeakRankedScore | null> {
  const scoringVersion =
    String(options.scoringVersion ?? '').trim() || DEFAULT_LEADERBOARD_RANK_SCORING_VERSION;
  const rows = await PlayerLeaderboardRankEvent.findAll({
    where: {
      playerId: options.playerId,
      scoringVersion,
    },
    order: [['effectiveDay', 'ASC']],
    attributes: ['rankedScoreRank', 'effectiveDay'],
  });
  return pickPeakRankHold(
    rows.map((row) => ({
      rankedScoreRank: row.get('rankedScoreRank'),
      effectiveDay: row.get('effectiveDay'),
    })),
  );
}

/**
 * Forward-filled daily series for Recharts. `null` before the first stored event in range.
 *
 * If the requested range exceeds {@link RANK_HISTORY_MAX_POINTS} days, only the **last**
 * N calendar days are returned (most recent history).
 */
export async function buildRankHistorySeries(options: {
  playerId: number;
  scoringVersion: string;
  from?: string;
  to?: string;
  stepDays?: number;
}): Promise<RankHistoryPoint[]> {
  const stepDays = Math.max(1, Math.floor(Number(options.stepDays ?? 1)));
  const events = await PlayerLeaderboardRankEvent.findAll({
    where: {
      playerId: options.playerId,
      scoringVersion: options.scoringVersion,
      ...(options.to ? { effectiveDay: { [Op.lte]: options.to } } : {}),
    },
    order: [['effectiveDay', 'ASC']],
    attributes: ['effectiveDay', 'rankedScoreRank', 'generalScoreRank'],
  });

  if (events.length === 0) {
    return [];
  }

  const rows = events.map((e) => {
    const rawDay = e.get('effectiveDay') as string | Date;
    const day =
      rawDay instanceof Date ? rawDay.toISOString().slice(0, 10) : String(rawDay).slice(0, 10);
    return {
      day,
      rankedScoreRank: Number(e.get('rankedScoreRank')),
      generalScoreRank: Number(e.get('generalScoreRank')),
    };
  });

  const computedFrom = options.from ?? rows[0]?.day;
  const computedTo = options.to ?? rows[rows.length - 1]?.day;
  if (!computedFrom || !computedTo || computedFrom > computedTo) {
    return [];
  }

  let dayList = [...iterateUtcDateOnlyRange(computedFrom, computedTo)];
  if (dayList.length === 0) {
    return [];
  }

  if (stepDays > 1) {
    dayList = dayList.filter((_, i) => i % stepDays === 0);
    if (dayList[dayList.length - 1] !== computedTo) {
      dayList.push(computedTo);
    }
  } else if (dayList.length > RANK_HISTORY_MAX_POINTS) {
    dayList = dayList.slice(dayList.length - RANK_HISTORY_MAX_POINTS);
  }

  let ptr = 0;
  let carried: { rankedScoreRank: number; generalScoreRank: number } | null = null;

  while (ptr < rows.length && rows[ptr].day < dayList[0]!) {
    carried = {
      rankedScoreRank: rows[ptr].rankedScoreRank,
      generalScoreRank: rows[ptr].generalScoreRank,
    };
    ptr++;
  }

  const out: RankHistoryPoint[] = [];
  for (const day of dayList) {
    while (ptr < rows.length && rows[ptr].day <= day) {
      carried = {
        rankedScoreRank: rows[ptr].rankedScoreRank,
        generalScoreRank: rows[ptr].generalScoreRank,
      };
      ptr++;
    }
    out.push({
      date: day,
      rankedScoreRank: carried?.rankedScoreRank ?? null,
      generalScoreRank: carried?.generalScoreRank ?? null,
    });
  }

  return out;
}
