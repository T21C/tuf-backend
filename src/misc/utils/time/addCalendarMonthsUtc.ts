/** Add whole calendar months in UTC (day clamped to month length, e.g. Jan 31 + 1 ➔ Feb 28/29). */
export function addCalendarMonthsUtc(from: Date, months: number): Date {
  if (!Number.isFinite(months) || months <= 0) return new Date(from);
  const y = from.getUTCFullYear();
  const mo = from.getUTCMonth();
  const d = from.getUTCDate();
  const h = from.getUTCHours();
  const min = from.getUTCMinutes();
  const s = from.getUTCSeconds();
  const ms = from.getUTCMilliseconds();

  const targetMonthIndex = mo + months;
  const targetYear = y + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;

  const lastDayOfTarget = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDayOfTarget);

  return new Date(Date.UTC(targetYear, targetMonth, day, h, min, s, ms));
}
