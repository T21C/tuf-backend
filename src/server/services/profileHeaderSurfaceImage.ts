import {
  getImageStackEntryIds,
  parseProfileHeaderSurfaceImageAssets,
  type ProfileHeaderSurfaceImageAssets,
  type ProfileHeaderSurfaceStyle,
} from '@/misc/utils/profileHeaderSurfaceStyle.js';
import cdnService from '@/server/services/core/CdnService.js';
import { logger } from '@/server/services/core/LoggerService.js';

export function styleHasImageLayer(style: ProfileHeaderSurfaceStyle | null): boolean {
  return style !== null && style.stack.some((e) => e.kind === 'image');
}

/** Layer ids referenced by the saved style stack. */
export function getReferencedImageLayerIds(style: ProfileHeaderSurfaceStyle | null): Set<string> {
  if (!style) return new Set();
  return new Set(getImageStackEntryIds(style.stack));
}

async function deleteCdnAsset(assetId: string): Promise<void> {
  try {
    if (await cdnService.checkFileExists(assetId)) {
      await cdnService.deleteFile(assetId);
    }
  } catch (err) {
    logger.error('Failed to delete profile header surface image from CDN:', err);
  }
}

/**
 * Drop CDN files and map entries for layers no longer in the style stack.
 * Returns the pruned assets map, or null if unchanged.
 */
export async function reconcileProfileHeaderSurfaceImageAssets(
  existingAssets: unknown,
  parsedStyle: ProfileHeaderSurfaceStyle | null,
): Promise<ProfileHeaderSurfaceImageAssets | null> {
  const assets = parseProfileHeaderSurfaceImageAssets(existingAssets);
  const referenced = getReferencedImageLayerIds(parsedStyle);
  const next: ProfileHeaderSurfaceImageAssets = {};
  let changed = false;

  for (const [layerId, row] of Object.entries(assets)) {
    if (referenced.has(layerId)) {
      next[layerId] = row;
    } else {
      changed = true;
      await deleteCdnAsset(row.assetId);
    }
  }

  if (!changed) return null;
  return next;
}

/** When saved style has no image layers, delete all CDN assets and clear the assets map. */
export async function clearSurfaceImageAssetsWhenNoImageLayers(
  existingAssets: unknown,
  parsedStyle: ProfileHeaderSurfaceStyle | null,
): Promise<{ profileHeaderSurfaceImageAssets: null } | null> {
  if (styleHasImageLayer(parsedStyle)) return null;

  const assets = parseProfileHeaderSurfaceImageAssets(existingAssets);
  if (Object.keys(assets).length === 0) return null;

  for (const row of Object.values(assets)) {
    await deleteCdnAsset(row.assetId);
  }

  return { profileHeaderSurfaceImageAssets: null };
}

/** Upsert one layer asset in the map (does not delete previous file — caller handles replacement). */
export function upsertSurfaceImageAsset(
  existingAssets: unknown,
  layerId: string,
  assetId: string,
  url: string,
): ProfileHeaderSurfaceImageAssets {
  const assets = parseProfileHeaderSurfaceImageAssets(existingAssets);
  return { ...assets, [layerId]: { assetId, url } };
}

/** Remove one layer from the assets map. */
export function removeSurfaceImageAsset(
  existingAssets: unknown,
  layerId: string,
): ProfileHeaderSurfaceImageAssets {
  const assets = parseProfileHeaderSurfaceImageAssets(existingAssets);
  const next = { ...assets };
  delete next[layerId];
  return next;
}
