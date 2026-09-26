import {KeyboardSetupError, type TimelinePeriod} from './types.js';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const OPEN_END = '9999-12-31';

export function parseSinceDate(raw: unknown, {allowNull = true} = {}): string | null {
  if (raw == null || raw === '') {
    if (!allowNull) {
      throw new KeyboardSetupError(400, 'sinceDate is required');
    }
    return null;
  }
  if (typeof raw !== 'string') {
    throw new KeyboardSetupError(400, 'sinceDate must be a YYYY-MM-DD UTC date');
  }
  const trimmed = raw.trim();
  const match = DATE_RE.exec(trimmed);
  if (!match) {
    throw new KeyboardSetupError(400, 'sinceDate must be a YYYY-MM-DD UTC date');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    throw new KeyboardSetupError(400, 'sinceDate is not a valid calendar date');
  }
  return trimmed;
}

export function utcDateFromInstant(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export function coerceSinceDate(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) return utcDateFromInstant(value);
  const text = String(value).slice(0, 10);
  return DATE_RE.test(text) ? text : null;
}

function startKey(value: unknown): string {
  return coerceSinceDate(value) ?? '';
}

function samePeriod<T extends TimelinePeriod>(left: T, right: T): boolean {
  if (left === right) return true;
  if (left.id && right.id && left.id === right.id) return true;
  return false;
}

export function isUntilAuto(period: {untilAuto?: boolean} | null | undefined): boolean {
  return period?.untilAuto !== false;
}

export function sortTimelinePeriods<T extends TimelinePeriod>(periods: T[]): T[] {
  return [...periods].sort((left, right) => {
    const leftDate = coerceSinceDate(left.sinceDate);
    const rightDate = coerceSinceDate(right.sinceDate);
    if (leftDate === rightDate) return left.id - right.id;
    if (leftDate == null) return -1;
    if (rightDate == null) return 1;
    return leftDate < rightDate ? -1 : 1;
  });
}

export function nextFittingStart<T extends TimelinePeriod>(period: T, group: T[]): string | null {
  const from = coerceSinceDate(period.sinceDate);
  let best: string | null = null;
  for (const other of group) {
    if (samePeriod(period, other)) continue;
    const start = coerceSinceDate(other.sinceDate);
    if (start == null) continue;
    if (from != null && start <= from) continue;
    if (best == null || start < best) best = start;
  }
  return best;
}

export function effectiveUntil<T extends TimelinePeriod>(period: T, group: T[] = [period]): string | null {
  if (isUntilAuto(period)) return nextFittingStart(period, group);
  return coerceSinceDate(period.untilDate);
}

export function periodCoversDate<T extends TimelinePeriod>(
  period: T,
  isoDate: string,
  group: T[] = [period],
): boolean {
  const from = coerceSinceDate(period.sinceDate);
  if (from != null && from > isoDate) return false;
  const until = effectiveUntil(period, group);
  if (until != null && isoDate >= until) return false;
  return true;
}

export function assertUniqueSinceDates(periods: Array<{sinceDate: string | Date | null}>): void {
  const seen = new Set<string>();
  let nullCount = 0;
  for (const period of periods) {
    const sinceDate = coerceSinceDate(period.sinceDate);
    if (sinceDate == null) {
      nullCount += 1;
      if (nullCount > 1) {
        throw new KeyboardSetupError(400, 'Only the earliest period may use an unknown start date');
      }
      continue;
    }
    if (seen.has(sinceDate)) {
      throw new KeyboardSetupError(400, `Duplicate since date ${sinceDate}`);
    }
    seen.add(sinceDate);
  }
}

export function assertRangeGroup<T extends TimelinePeriod>(periods: T[]): void {
  const list = periods.filter((period) => !period.isGap);
  for (const period of list) {
    const from = coerceSinceDate(period.sinceDate);
    const until = effectiveUntil(period, list);
    if (from && until && until <= from) {
      throw new KeyboardSetupError(400, 'untilDate must be after sinceDate');
    }
  }
  for (let i = 0; i < list.length; i += 1) {
    const aFrom = startKey(list[i].sinceDate);
    const aUntil = effectiveUntil(list[i], list) ?? OPEN_END;
    for (let j = i + 1; j < list.length; j += 1) {
      const bFrom = startKey(list[j].sinceDate);
      const bUntil = effectiveUntil(list[j], list) ?? OPEN_END;
      if (aFrom < bUntil && bFrom < aUntil) {
        throw new KeyboardSetupError(400, 'These date ranges overlap');
      }
    }
  }
}

export function findPeriodAt<T extends TimelinePeriod>(
  periods: T[],
  isoDate: string,
  group: T[] = periods,
): T | null {
  const covering = sortTimelinePeriods(periods).filter((period) =>
    periodCoversDate(period, isoDate, group),
  );
  return covering.length ? covering[covering.length - 1] : null;
}

export function currentPeriod<T extends TimelinePeriod>(periods: T[]): T | null {
  const sorted = sortTimelinePeriods(periods);
  return sorted.length ? sorted[sorted.length - 1] : null;
}
