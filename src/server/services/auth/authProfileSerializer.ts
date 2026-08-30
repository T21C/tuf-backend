import { OAuthProvider, User } from '@/models/index.js';
import Player from '@/models/players/Player.js';
import { hasFlag } from '@/misc/utils/auth/permissionUtils.js';
import { permissionFlags } from '@/config/constants.js';
import {
  accountCredentialService,
} from '@/server/services/accounts/AccountCredentialService.js';
import {
  reconcileExpiredTufStellarAccess,
} from '@/misc/utils/subscriptions/tufStellarSubscription.js';
import { loadUserTufStellarBilling } from '@/server/services/billing/userTufStellarBillingSupport.js';
import { isTufStellarFeatureEnabled } from '@/config/app.config.js';
import { getClientPreferences } from '@/server/services/auth/ClientPreferenceService.js';

/**
 * Full auth profile payload used by GET /auth/profile/me and GET /auth/session.
 * Richer than publicUserFields (player, providers, billing, credential flags).
 */
export async function buildAuthProfileUser(userId: string) {
  const user = await User.findByPk(userId);
  if (!user) {
    return null;
  }

  await reconcileExpiredTufStellarAccess(user);
  await user.reload();

  const billing = await loadUserTufStellarBilling(user.id);
  const stellarOn = isTufStellarFeatureEnabled();

  const providers = await OAuthProvider.findAll({
    where: { userId: user.id },
    attributes: ['provider', 'providerId'],
  });

  const player = await Player.findByPk(user.playerId);
  const clientPreferences = await getClientPreferences(user.id);

  return {
    id: user.id,
    creatorId: user.creatorId,
    username: user.username,
    nickname: user.nickname || user.username,
    email: user.email,
    pendingEmail: user.pendingEmail ?? null,
    emailResendAvailableAt:
      accountCredentialService.getEmailResendAvailableAt(user)?.toISOString() ?? null,
    avatarUrl: user.avatarUrl ?? null,
    avatarIsGif: Boolean(user.avatarIsGif),
    tufStellarSubscriptionExpiresAt: stellarOn
      ? (billing?.tufStellarSubscriptionExpiresAt ?? null)
      : null,
    tufStellarEnabled: stellarOn,
    isRater: hasFlag(user, permissionFlags.RATER),
    isSuperAdmin: hasFlag(user, permissionFlags.SUPER_ADMIN),
    isRatingBanned: hasFlag(user, permissionFlags.RATING_BANNED),
    isTagVoteBanned: hasFlag(user, permissionFlags.TAG_VOTE_BANNED),
    isEmailVerified: hasFlag(user, permissionFlags.EMAIL_VERIFIED),
    permissionFlags: user.permissionFlags,
    playerId: user.playerId,
    password: user.password ? true : null,
    player,
    lastUsernameChange: user.lastUsernameChange,
    previousUsername: user.previousUsername,
    deletionScheduledAt: user.deletionScheduledAt ?? null,
    deletionExecuteAt: user.deletionExecuteAt ?? null,
    deletionIncludeCreator: Boolean(user.deletionIncludeCreator),
    providers: providers.map((p: OAuthProvider) => ({
      name: p.provider,
      providerId: p.providerId,
    })),
    clientPreferences,
  };
}

export type AuthProfileUser = NonNullable<Awaited<ReturnType<typeof buildAuthProfileUser>>>;
