import type User from '@/models/auth/User.js';
import type { UserAttributes } from '@/models/auth/User.js';
import type UserTufStellarBilling from '@/models/billing/UserTufStellarBilling.js';
import { permissionFlags } from '@/config/constants.js';
import { hasFlag } from '@/misc/utils/auth/permissionUtils.js';
import { isTufStellarFeatureEnabled } from '@/config/app.config.js';
export type UserRow = User | UserAttributes;

function parseExpiryMs(raw: Date | string | null | undefined): number | null {
  if (raw == null) return null;
  const t = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Whether stacked access (`tufStellarSubscriptionExpiresAt`) is strictly in the future. */
export function tufStellarExpiresAtActive(expiresAt: Date | string | null | undefined): boolean {
  if (!isTufStellarFeatureEnabled()) return false;
  const ms = parseExpiryMs(expiresAt ?? null);
  if (ms == null) return false;
  return ms > Date.now();
}

/**
 * TUFStellar benefits apply when `tufStellarSubscriptionExpiresAt` on the billing row is strictly in the future
 * (purchase-funded stacked time; column name is historical).
 */
export function isTufStellarAccessActive(_user: UserRow, billing: UserTufStellarBilling | null): boolean {
  return tufStellarExpiresAtActive(billing?.tufStellarSubscriptionExpiresAt ?? null);
}

export type TufStellarIconVariantId = '1' | '2' | '3';

/**
 * Normalize stored/API variant to `1`, `2`, or `3`.
 */
export function normalizeTufStellarIconVariant(raw: unknown): TufStellarIconVariantId {
  const s = raw == null ? '' : String(raw).trim();
  if (s === '2' || s === '3') return s;
  return '1';
}

/**
 * Custom profile banner uploads and animated GIF avatars (when globally enabled).
 */
export function canUseStellarProfileCustomization(
  user: UserRow | null | undefined,
  billing: UserTufStellarBilling | null,
): boolean {
  if (!user) return false;
  if (hasFlag(user, permissionFlags.SUPER_ADMIN)) return true;
  if (isTufStellarAccessActive(user, billing)) return true;
  return false;
}

/** No-op placeholder kept for call sites that refresh billing context before routes. */
export async function reconcileExpiredTufStellarAccess(user: User): Promise<void> {
  void user;
}

/**
 * PROFILE GIF CDN layout: `…/original_animated`, `…/large_animated`, … plus `…/original_static` (PNG or JPEG).
 * When TUFStellar access is inactive, swap `_animated` ➔ `_static` on the path. Legacy GIFs used `…/original`
 * with `…/original_static` only — still supported here for media redirects.
 */
export function getEffectiveAvatarDisplayUrl(
  avatarUrl: string | null | undefined,
  avatarIsGif: boolean | null | undefined,
  accessActive: boolean,
): string | null {
  if (avatarUrl == null || avatarUrl === '') return null;
  if (!avatarIsGif || accessActive) return avatarUrl;
  if (avatarUrl.includes('_animated')) {
    return avatarUrl.replace(/_animated/g, '_static');
  }
  return avatarUrl.replace(/\/original(?=$|[?#])/, '/original_static');
}

export function effectiveAvatarForUserRow(
  user: UserRow | null | undefined,
  accessExpiresAt: Date | string | null | undefined,
): string | null {
  if (!user) return null;
  return getEffectiveAvatarDisplayUrl(
    user.avatarUrl ?? null,
    Boolean(user.avatarIsGif),
    tufStellarExpiresAtActive(accessExpiresAt ?? null),
  );
}
