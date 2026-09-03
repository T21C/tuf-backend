export type PeakRankHold = {
  rank: number;
  date: string;
};

function utcDateOnly(raw: string | Date | null | undefined): string | null {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const day = raw.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
  }
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    const y = raw.getUTCFullYear();
    const mo = String(raw.getUTCMonth() + 1).padStart(2, '0');
    const d = String(raw.getUTCDate()).padStart(2, '0');
    return `${y}-${mo}-${d}`;
  }
  return null;
}

function previousUtcDateOnly(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return dateStr;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  dt.setUTCDate(dt.getUTCDate() - 1);
  const y = dt.getUTCFullYear();
  const mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

/**
 * Best (lowest positive) ranked-score rank and the last UTC day of the most recent
 * hold at that rank. Rank events are change-deltas, so that end day is the calendar
 * day before the next event (the drop), not the day the peak was first reached.
 */
export function pickPeakRankHold(
  events: Array<{ rankedScoreRank: unknown; effectiveDay: unknown }>,
): PeakRankHold | null {
  const rows: { rank: number; day: string }[] = [];
  for (const event of events) {
    const rank = Number(event.rankedScoreRank);
    const day = utcDateOnly(event.effectiveDay as string | Date | null | undefined);
    if (!Number.isFinite(rank) || !day) continue;
    rows.push({ rank, day });
  }
  rows.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  if (rows.length === 0) return null;

  let minRank = Infinity;
  for (const row of rows) {
    if (row.rank > 0 && row.rank < minRank) minRank = row.rank;
  }
  if (!Number.isFinite(minRank)) return null;

  let lastPeakIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].rank === minRank) lastPeakIdx = i;
  }
  if (lastPeakIdx < 0) return null;

  const startDay = rows[lastPeakIdx].day;
  const next = rows[lastPeakIdx + 1];
  if (!next) return { rank: minRank, date: startDay };

  const endDay = previousUtcDateOnly(next.day);
  return { rank: minRank, date: endDay < startDay ? startDay : endDay };
}
