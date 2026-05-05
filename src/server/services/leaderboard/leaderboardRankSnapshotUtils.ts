/**
 * UTC calendar helpers for daily leaderboard snapshots.
 * `effectiveDay` is a DATE (UTC) labeling the day whose **end** instant is `cutoff`.
 */

export function utcEndOfCalendarDayUtc(year: number, month0: number, day: number): Date {
  return new Date(Date.UTC(year, month0, day, 23, 59, 59, 999));
}

export function parseIsoDateOnly(s: string): { y: number; m0: number; d: number } {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(s.trim());
  if (!m) throw new Error(`Invalid DATEONLY string: ${s}`);
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  if (!Number.isFinite(y) || mo < 0 || mo > 11 || d < 1 || d > 31) throw new Error(`Invalid DATEONLY: ${s}`);
  return { y, m0: mo, d };
}

export function utcEndOfIsoDateOnly(dateStr: string): Date {
  const { y, m0, d } = parseIsoDateOnly(dateStr);
  return utcEndOfCalendarDayUtc(y, m0, d);
}

/** Previous calendar day in UTC (for DATEONLY strings). */
export function utcPreviousIsoDateOnly(dateStr: string): string {
  const { y, m0, d } = parseIsoDateOnly(dateStr);
  const dt = new Date(Date.UTC(y, m0, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return utcDateOnlyFromDate(dt);
}

export function utcNextIsoDateOnly(dateStr: string): string {
  const { y, m0, d } = parseIsoDateOnly(dateStr);
  const dt = new Date(Date.UTC(y, m0, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return utcDateOnlyFromDate(dt);
}

export function utcDateOnlyFromDate(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

/** Iterate DATEONLY strings from `from` through `to` inclusive (UTC). */
export function* iterateUtcDateOnlyRange(from: string, to: string): Generator<string> {
  let cur = parseIsoDateOnly(from);
  const end = parseIsoDateOnly(to);
  const curTime = new Date(Date.UTC(cur.y, cur.m0, cur.d)).getTime();
  const endTime = new Date(Date.UTC(end.y, end.m0, end.d)).getTime();
  if (curTime > endTime) return;
  for (let t = curTime; t <= endTime; t += 86400000) {
    yield utcDateOnlyFromDate(new Date(t));
  }
}
