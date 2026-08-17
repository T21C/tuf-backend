import {permissionFlags} from '@/config/constants.js';
import {hasFlag, type PermissionInput} from '@/misc/utils/auth/permissionUtils.js';

export const BAN_DURATION_UNITS = ['hours', 'days', 'weeks', 'months'] as const;
export type BanDurationUnit = (typeof BAN_DURATION_UNITS)[number];

export const BAN_DURATION_MIN = 1;
export const BAN_DURATION_MAX = 999;

export class PlayerBanError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'PlayerBanError';
    this.status = status;
  }
}

export type BanDurationInput = {
  duration: unknown;
  unit: unknown;
};

type BanPlayerShape = {
  isBanned?: boolean;
  bannedUntil?: Date | string | null;
} | null | undefined;

function parseBannedUntilMs(bannedUntil?: Date | string | null): number | null {
  if (bannedUntil === null || bannedUntil === undefined || bannedUntil === '') return null;
  const ms = new Date(bannedUntil).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export function isBannedUntilExpired(bannedUntil?: Date | string | null): boolean {
  const until = parseBannedUntilMs(bannedUntil);
  return until !== null && until <= Date.now();
}

/**
 * Permission-flag ban is active unless `bannedUntil` is set and already past.
 * Joke/leaderboard `players.isBanned` without BANNED is ignored (Ban Hammer).
 */
export function isPermissionBanActive(
  user?: PermissionInput,
  bannedUntil?: Date | string | null,
): boolean {
  if (!hasFlag(user, permissionFlags.BANNED)) return false;
  return !isBannedUntilExpired(bannedUntil);
}

export function isBanCurrentlyActive(player?: BanPlayerShape, user?: PermissionInput): boolean {
  const flagged = hasFlag(user, permissionFlags.BANNED) || Boolean(player?.isBanned);
  if (!flagged) return false;
  return !isBannedUntilExpired(player?.bannedUntil ?? null);
}

/** Staff ban still in force — temp expiry in the future, or BANNED with no expiry. */
export function isAdminBanActive(player?: BanPlayerShape, user?: PermissionInput): boolean {
  const untilMs = parseBannedUntilMs(player?.bannedUntil ?? null);
  if (untilMs !== null) return untilMs > Date.now();
  return hasFlag(user, permissionFlags.BANNED);
}

export function parseBanDuration(input: BanDurationInput): {duration: number; unit: BanDurationUnit} {
  const durationNum = typeof input.duration === 'number'
    ? input.duration
    : typeof input.duration === 'string' && input.duration.trim() !== ''
      ? Number(input.duration)
      : NaN;

  if (!Number.isInteger(durationNum) || durationNum < BAN_DURATION_MIN || durationNum > BAN_DURATION_MAX) {
    throw new PlayerBanError(
      400,
      `duration must be an integer from ${BAN_DURATION_MIN} to ${BAN_DURATION_MAX}`,
    );
  }

  const unit = input.unit;
  if (typeof unit !== 'string' || !BAN_DURATION_UNITS.includes(unit as BanDurationUnit)) {
    throw new PlayerBanError(400, 'unit must be hours, days, weeks, or months');
  }

  return {duration: durationNum, unit: unit as BanDurationUnit};
}

export function computeBannedUntil(
  duration: number,
  unit: BanDurationUnit,
  now = new Date(),
): Date {
  const result = new Date(now.getTime());
  switch (unit) {
    case 'hours':
      result.setTime(result.getTime() + duration * 60 * 60 * 1000);
      break;
    case 'days':
      result.setTime(result.getTime() + duration * 24 * 60 * 60 * 1000);
      break;
    case 'weeks':
      result.setTime(result.getTime() + duration * 7 * 24 * 60 * 60 * 1000);
      break;
    case 'months':
      result.setMonth(result.getMonth() + duration);
      break;
    default:
      throw new PlayerBanError(400, 'unit must be hours, days, weeks, or months');
  }
  return result;
}
