import {
  ProfileCustomizationError,
  getPieceForEntity,
  upsertPieceForEntity,
  type ProfileEntityKind,
} from './ProfileCustomizationService.js';
import {loadUserTufStellarBilling} from '@/server/services/billing/userTufStellarBillingSupport.js';
import User from '@/models/auth/User.js';
import {canUseStellarProfileCustomization} from '@/misc/utils/subscriptions/tufStellarSubscription.js';
import {
  ProfileModulesError,
  assertModuleCountAllowed,
  collectFavoriteItems,
  parseProfileModulesDocument,
  previousModuleCount,
  profileModulesCap,
  readStoredProfileModules,
  type ProfileModulesDocument,
} from '@/misc/utils/profileModules/index.js';
import {hydrateFavoriteItems, type HydratedFavoriteItem} from './hydrateFavoriteItems.js';

export type ProfileModulesApiPayload = {
  profileModules: ProfileModulesDocument | null;
  profileModulesResolved: Record<string, {items: HydratedFavoriteItem[]}>;
};

function storedFromPiece(payload: unknown): ProfileModulesDocument | null {
  return readStoredProfileModules(payload);
}

async function resolveFavoriteItems(
  document: ProfileModulesDocument | null,
): Promise<Record<string, {items: HydratedFavoriteItem[]}>> {
  if (!document) return {};
  const resolved: Record<string, {items: HydratedFavoriteItem[]}> = {};
  for (const mod of document.modules) {
    if (mod.type !== 'favorite') continue;
    const items = collectFavoriteItems({version: 1, modules: [mod]});
    resolved[mod.id] = {items: await hydrateFavoriteItems(items)};
  }
  return resolved;
}

export async function getProfileModulesApiPayload(
  entityKind: ProfileEntityKind,
  entityId: number,
): Promise<ProfileModulesApiPayload> {
  const piece = await getPieceForEntity(entityKind, entityId, 'profile_modules');
  const profileModules = storedFromPiece(piece?.payload ?? null);
  const profileModulesResolved = await resolveFavoriteItems(profileModules);
  return {profileModules, profileModulesResolved};
}

export async function saveProfileModulesForEntity(opts: {
  entityKind: ProfileEntityKind;
  entityId: number;
  userId: string;
  raw: unknown;
}): Promise<ProfileModulesApiPayload> {
  const {entityKind, entityId, userId, raw} = opts;
  let next: ProfileModulesDocument;
  try {
    next = parseProfileModulesDocument(raw, entityKind);
  } catch (error) {
    if (error instanceof ProfileModulesError) {
      throw new ProfileCustomizationError(400, error.message);
    }
    throw error;
  }

  const existing = await getPieceForEntity(entityKind, entityId, 'profile_modules');
  const previous = storedFromPiece(existing?.payload ?? null);
  const user = await User.findByPk(userId);
  if (!user) {
    throw new ProfileCustomizationError(404, 'User not found');
  }
  const billing = await loadUserTufStellarBilling(userId);
  const cap = profileModulesCap(canUseStellarProfileCustomization(user, billing));

  try {
    assertModuleCountAllowed({
      previousCount: previousModuleCount(previous, entityKind),
      nextCount: next.modules.length,
      cap,
    });
  } catch (error) {
    if (error instanceof ProfileModulesError) {
      throw new ProfileCustomizationError(400, error.message);
    }
    throw error;
  }

  const favoriteItems = collectFavoriteItems(next);
  if (favoriteItems.length) {
    const hydrated = await hydrateFavoriteItems(favoriteItems);
    const ok = new Set(hydrated.map((row) => `${row.kind}:${row.id}`));
    const missing = favoriteItems.find((item) => !ok.has(`${item.kind}:${item.id}`));
    if (missing) {
      throw new ProfileCustomizationError(
        400,
        'One or more favorite items are hidden, private, or do not exist',
      );
    }
  }

  await upsertPieceForEntity(
    entityKind,
    entityId,
    'profile_modules',
    next as unknown as Record<string, unknown>,
  );
  const profileModulesResolved = await resolveFavoriteItems(next);
  return {profileModules: next, profileModulesResolved};
}
