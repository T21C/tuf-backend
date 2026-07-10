import { parseBannerPresetForStorage } from '@/misc/utils/profileBannerPreset.js';
import { normalizeTufStellarIconVariant } from '@/misc/utils/subscriptions/tufStellarSubscription.js';
import {
  parseProfileHeaderSurfaceStyle,
  type ProfileHeaderSurfaceImageAssets,
  type ProfileHeaderSurfaceStyle,
} from '@/misc/utils/profileHeaderSurfaceStyle.js';
import cdnService from '@/server/services/core/CdnService.js';
import {
  clearSurfaceImageAssetsWhenNoImageLayers,
  getReferencedImageLayerIds,
  reconcileProfileHeaderSurfaceImageAssets,
  removeSurfaceImageAsset,
  upsertSurfaceImageAsset,
} from '@/server/services/profileHeaderSurfaceImage.js';
import {
  getPieceForEntity,
  patchPiecePayloadForEntity,
  type ProfileEntityKind,
} from '@/server/services/profileCustomization/ProfileCustomizationService.js';
import { reindexProfilesForIds } from '@/server/services/profileCustomization/reindexProfiles.js';

async function reindexForPiece(
  entityKind: ProfileEntityKind,
  entityId: number,
  piece: { playerId: number | null; creatorId: number | null },
): Promise<void> {
  await reindexProfilesForIds({
    playerIds: piece.playerId != null ? [piece.playerId] : entityKind === 'player' ? [entityId] : [],
    creatorIds: piece.creatorId != null ? [piece.creatorId] : entityKind === 'creator' ? [entityId] : [],
  });
}

export async function setBannerPresetForEntity(
  entityKind: ProfileEntityKind,
  entityId: number,
  presetRaw: unknown,
): Promise<{ bannerPreset: string | null }> {
  const preset = parseBannerPresetForStorage(presetRaw);
  const piece = await patchPiecePayloadForEntity(entityKind, entityId, 'banner', (current) => ({
    ...current,
    bannerPreset: preset,
  }));
  await reindexForPiece(entityKind, entityId, piece);
  return { bannerPreset: preset };
}

export async function clearBannerPresetForEntity(
  entityKind: ProfileEntityKind,
  entityId: number,
): Promise<{ bannerPreset: null }> {
  const piece = await patchPiecePayloadForEntity(entityKind, entityId, 'banner', (current) => ({
    ...current,
    bannerPreset: null,
  }));
  await reindexForPiece(entityKind, entityId, piece);
  return { bannerPreset: null };
}

export async function uploadCustomBannerForEntity(
  entityKind: ProfileEntityKind,
  entityId: number,
  file: Express.Multer.File,
): Promise<{ customBannerId: string; customBannerUrl: string }> {
  const result = await cdnService.uploadImage(file.buffer, file.originalname, 'BANNER');
  const displayUrl = result.urls?.large ?? result.urls?.original ?? null;
  if (!displayUrl) {
    throw new Error('CDN did not return banner URLs');
  }

  const piece = await patchPiecePayloadForEntity(entityKind, entityId, 'banner', (current) => ({
    ...current,
    customBannerId: result.fileId,
    customBannerUrl: displayUrl,
  }));
  await reindexForPiece(entityKind, entityId, piece);
  return { customBannerId: result.fileId, customBannerUrl: displayUrl };
}

export async function clearCustomBannerForEntity(
  entityKind: ProfileEntityKind,
  entityId: number,
): Promise<{ customBannerId: null; customBannerUrl: null }> {
  const piece = await patchPiecePayloadForEntity(entityKind, entityId, 'banner', (current) => ({
    ...current,
    customBannerId: null,
    customBannerUrl: null,
  }));
  await reindexForPiece(entityKind, entityId, piece);
  return { customBannerId: null, customBannerUrl: null };
}

export async function patchHeaderSurfaceStyleForEntity(
  entityKind: ProfileEntityKind,
  entityId: number,
  styleBody: unknown,
): Promise<{
  profileHeaderSurfaceStyle: ProfileHeaderSurfaceStyle | null;
  profileHeaderSurfaceImageAssets: ProfileHeaderSurfaceImageAssets | null;
}> {
  const parsed = parseProfileHeaderSurfaceStyle(styleBody);
  const existingPiece = await getPieceForEntity(entityKind, entityId, 'header_surface');
  const existingPayload = existingPiece?.payload ?? {};
  const existingAssets = existingPayload.profileHeaderSurfaceImageAssets;

  const cleared = await clearSurfaceImageAssetsWhenNoImageLayers(existingAssets, parsed);
  const reconciled = await reconcileProfileHeaderSurfaceImageAssets(existingAssets, parsed);

  let nextAssets: ProfileHeaderSurfaceImageAssets | null =
    existingAssets && typeof existingAssets === 'object' && !Array.isArray(existingAssets)
      ? (existingAssets as ProfileHeaderSurfaceImageAssets)
      : null;
  if (cleared?.profileHeaderSurfaceImageAssets === null) {
    nextAssets = null;
  } else if (reconciled !== null) {
    nextAssets = reconciled;
  }

  const piece = await patchPiecePayloadForEntity(entityKind, entityId, 'header_surface', () => ({
    profileHeaderSurfaceStyle: parsed as unknown as Record<string, unknown> | null,
    profileHeaderSurfaceImageAssets: nextAssets,
  }));

  await reindexForPiece(entityKind, entityId, piece);
  return {
    profileHeaderSurfaceStyle: parsed,
    profileHeaderSurfaceImageAssets: nextAssets,
  };
}

export async function uploadHeaderSurfaceImageForEntity(
  entityKind: ProfileEntityKind,
  entityId: number,
  layerId: string,
  file: Express.Multer.File,
): Promise<{ profileHeaderSurfaceImageAssets: ProfileHeaderSurfaceImageAssets }> {
  const existingPiece = await getPieceForEntity(entityKind, entityId, 'header_surface');
  const existingPayload = existingPiece?.payload ?? {};
  const storedStyle = parseProfileHeaderSurfaceStyle(existingPayload.profileHeaderSurfaceStyle);
  if (!storedStyle) {
    throw new Error('Save header surface style before uploading layer images');
  }
  if (!getReferencedImageLayerIds(storedStyle).has(layerId)) {
    throw new Error('layerId does not match an image layer in the saved style');
  }

  const result = await cdnService.uploadImage(file.buffer, file.originalname, 'BANNER');
  const displayUrl = result.urls?.large ?? result.urls?.original ?? null;
  if (!displayUrl) {
    throw new Error('CDN did not return image URLs');
  }

  const assets = upsertSurfaceImageAsset(
    existingPayload.profileHeaderSurfaceImageAssets,
    layerId,
    result.fileId,
    displayUrl,
  );

  const piece = await patchPiecePayloadForEntity(entityKind, entityId, 'header_surface', (current) => ({
    ...current,
    profileHeaderSurfaceImageAssets: assets,
  }));
  await reindexForPiece(entityKind, entityId, piece);
  return { profileHeaderSurfaceImageAssets: assets };
}

export async function deleteHeaderSurfaceImageForEntity(
  entityKind: ProfileEntityKind,
  entityId: number,
  layerId: string,
): Promise<{ profileHeaderSurfaceImageAssets: ProfileHeaderSurfaceImageAssets | null }> {
  const existingPiece = await getPieceForEntity(entityKind, entityId, 'header_surface');
  const existingPayload = existingPiece?.payload ?? {};
  const assets = removeSurfaceImageAsset(existingPayload.profileHeaderSurfaceImageAssets, layerId);

  const piece = await patchPiecePayloadForEntity(entityKind, entityId, 'header_surface', (current) => ({
    ...current,
    profileHeaderSurfaceImageAssets: Object.keys(assets).length ? assets : null,
  }));
  await reindexForPiece(entityKind, entityId, piece);
  return {
    profileHeaderSurfaceImageAssets: Object.keys(assets).length ? assets : null,
  };
}

export async function setStellarIconVariantForEntity(
  entityKind: ProfileEntityKind,
  entityId: number,
  variantRaw: unknown,
): Promise<{ tufStellarIconVariant: string }> {
  const variant = normalizeTufStellarIconVariant(variantRaw);
  const piece = await patchPiecePayloadForEntity(entityKind, entityId, 'stellar_icon', () => ({
    tufStellarIconVariant: variant,
  }));
  await reindexForPiece(entityKind, entityId, piece);
  return { tufStellarIconVariant: variant };
}
