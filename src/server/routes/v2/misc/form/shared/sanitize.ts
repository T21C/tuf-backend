import {LARGE_TEXT_MAX, parseLargeText} from '@/misc/utils/textLimits.js';

/**
 * Small, pure primitives used by every form route. No DB, no I/O, no logging.
 */

export function sanitizeTextInput(input: string | null | undefined, maxLength = 1000): string {
  if (input === null || input === undefined) return '';
  return String(input).trim().slice(0, maxLength);
}

export const NOTES_MAX_LENGTH = LARGE_TEXT_MAX;
export const LEVEL_DESCRIPTION_MAX_LENGTH = 2000;
export const FEELING_EXPLANATION_MAX_LENGTH = LARGE_TEXT_MAX;

function throwLargeText(parsed: ReturnType<typeof parseLargeText>, fallback: string): never {
  throw {error: parsed.ok ? fallback : parsed.message, code: 400};
}

export function sanitizeNotes(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const parsed = parseLargeText(input, {label: 'Notes'});
  if (!parsed.ok) throwLargeText(parsed, 'Notes are too long');
  return parsed.value.length > 0 ? parsed.value : null;
}

/** Optional website-only level description: trim, empty → null. Throws if invalid. */
export function sanitizeLevelDescription(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') {
    throw { error: 'Level description must be a string', code: 400 };
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > LEVEL_DESCRIPTION_MAX_LENGTH) {
    throw {
      error: `Level description cannot exceed ${LEVEL_DESCRIPTION_MAX_LENGTH} characters`,
      code: 400,
    };
  }
  return trimmed;
}

/** Optional GQ/UQ feeling-rating explanation: trim, empty → null. Throws if invalid. */
export function sanitizeFeelingExplanation(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') {
    throw { error: 'Feeling explanation must be a string', code: 400 };
  }
  const parsed = parseLargeText(input, {label: 'Feeling explanation'});
  if (!parsed.ok) throwLargeText(parsed, 'Feeling explanation is too long');
  return parsed.value.length > 0 ? parsed.value : null;
}

/** Optional website-only pass details: trim, empty → null. Throws if invalid. */
export function sanitizePassDetails(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') {
    throw { error: 'Pass details must be a string', code: 400 };
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > LEVEL_DESCRIPTION_MAX_LENGTH) {
    throw {
      error: `Pass details cannot exceed ${LEVEL_DESCRIPTION_MAX_LENGTH} characters`,
      code: 400,
    };
  }
  return trimmed;
}

/** Optional admin reason from a JSON body `{ reason?: string }`. */
export function optionalReasonFromBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  return sanitizeNotes((body as { reason?: unknown }).reason);
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
