import type User from '@/models/auth/User.js';
import type { UserAttributes } from '@/models/auth/User.js';
import { permissionFlags } from '@/config/constants.js';
import { hasFlag } from '@/misc/utils/auth/permissionUtils.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import { reconcileBillingLifecycleIfExpired } from '@/misc/utils/subscriptions/billingLifecycleTransition.js';

const elasticsearchService = ElasticsearchService.getInstance();

export type UserRow = User | UserAttributes;

function parseExpiryMs(raw: Date | string | null | undefined): number | null {
  if (raw == null) return null;
  const t = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * TUFStellar benefits apply when `tufStellarSubscriptionExpiresAt` is set and strictly in the future.
 */
export function isTufStellarSubscriptionActive(user: UserRow): boolean {
  const ms = parseExpiryMs(user.tufStellarSubscriptionExpiresAt ?? null);
  if (ms == null) return false;
  return ms > Date.now();
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
export function canUseStellarProfileCustomization(user: UserRow | null | undefined): boolean {
  if (!user) return false;
  if (hasFlag(user, permissionFlags.SUPER_ADMIN)) return true;
  if (isTufStellarSubscriptionActive(user)) return true;
  return false;
}

/**
 * When the paid period has ended (or is missing), align `tufStellarBillingLifecycleState` to `inactive`
 * if needed and reindex the linked player so public search/docs match subscription facts.
 */
export async function reconcileExpiredTufStellarSubscription(user: User): Promise<void> {
  if (isTufStellarSubscriptionActive(user)) return;

  const changed = await reconcileBillingLifecycleIfExpired(user);
  if (changed && user.playerId != null) {
    try {
      await elasticsearchService.reindexPlayers([user.playerId]);
    } catch {
      // Best-effort; DB state is authoritative.
    }
  }
}

/**
 * PROFILE GIF CDN layout: `…/original_animated`, `…/large_animated`, … plus `…/original_static` (JPEG).
 * When the subscription is inactive, swap `_animated` → `_static` on the path. Legacy GIFs used `…/original`
 * with `…/original_static` only — still supported here for media redirects.
 */
export function getEffectiveAvatarDisplayUrl(
  avatarUrl: string | null | undefined,
  avatarIsGif: boolean | null | undefined,
  subscriptionActive: boolean,
): string | null {
  if (avatarUrl == null || avatarUrl === '') return null;
  if (!avatarIsGif || subscriptionActive) return avatarUrl;
  if (avatarUrl.includes('_animated')) {
    return avatarUrl.replace(/_animated/g, '_static');
  }
  return avatarUrl.replace(/\/original(?=$|[?#])/, '/original_static');
}

export function effectiveAvatarForUserRow(user: UserRow | null | undefined): string | null {
  if (!user) return null;
  return getEffectiveAvatarDisplayUrl(
    user.avatarUrl ?? null,
    Boolean(user.avatarIsGif),
    isTufStellarSubscriptionActive(user),
  );
}
