import type User from '@/models/auth/User.js';
import type { UserAttributes } from '@/models/auth/User.js';
import { permissionFlags } from '@/config/constants.js';
import { hasFlag, setUserPermissionAndSave } from '@/misc/utils/auth/permissionUtils.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import {
  getBillingLifecycleState,
  transitionBillingLifecycle,
} from '@/misc/utils/subscriptions/billingLifecycleTransition.js';

const elasticsearchService = ElasticsearchService.getInstance();

export type UserRow = User | UserAttributes;

function parseExpiryMs(raw: Date | string | null | undefined): number | null {
  if (raw == null) return null;
  const t = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * TUFStellar is active when the stored expiry is strictly in the future.
 * (Webhook / admin flows should keep permissionFlags.TUF_STELLAR in sync via
 * {@link syncTufStellarPermissionFromExpiry}.)
 */
export function isTufStellarSubscriptionActive(user: UserRow): boolean {
  const ms = parseExpiryMs(user.tufStellarSubscriptionExpiresAt ?? null);
  if (ms == null) return false;
  return ms > Date.now();
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
 * If subscription has lapsed, clear TUF_STELLAR and bump permission version.
 * Reindexes the linked player when the flag changes so public `pfp` matches presentation.
 */
export async function syncTufStellarPermissionFromExpiry(user: User): Promise<void> {
  const ms = parseExpiryMs(user.tufStellarSubscriptionExpiresAt ?? null);
  if (ms == null) return;
  if (ms > Date.now()) return;
  if (!hasFlag(user, permissionFlags.TUF_STELLAR)) return;
  await setUserPermissionAndSave(user, permissionFlags.TUF_STELLAR, false);
  const lifecycleFrom = getBillingLifecycleState(user);
  const lifecycleNext = transitionBillingLifecycle(lifecycleFrom, { type: 'facts_subscription_lapsed' });
  if (lifecycleNext !== lifecycleFrom) {
    await user.update({ tufStellarBillingLifecycleState: lifecycleNext });
  }
  if (user.playerId != null) {
    try {
      await elasticsearchService.reindexPlayers([user.playerId]);
    } catch (e) {
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
