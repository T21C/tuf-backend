/**
 * Small, pure primitives used by every form route. No DB, no I/O, no logging.
 */

export function sanitizeTextInput(input: string | null | undefined, maxLength = 1000): string {
  if (input === null || input === undefined) return '';
  return String(input).trim().slice(0, maxLength);
}

/**
 * Accepts a loose date-like value and returns a Date inside the [2020-01-01, now+1d]
 * window, or null if the input is not parseable / out of range.
 */
export function validateDateInput(input: unknown): Date | null {
  if (input === null || input === undefined || input === '') return null;
  const date = new Date(input as string);
  if (Number.isNaN(date.getTime())) return null;
  const minDate = new Date('2020-01-01');
  const maxDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
  if (date < minDate || date > maxDate) return null;
  return date;
}

export function validateNumericInput(input: unknown, min = 0, max: number = Number.MAX_SAFE_INTEGER): number {
  const parsed = parseInt(String(input ?? '0'));
  if (Number.isNaN(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
}

export function validateFloatInput(input: unknown, min = 0, max: number = Number.MAX_SAFE_INTEGER): number {
  const parsed = parseFloat(String(input ?? '0'));
  if (Number.isNaN(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
}
