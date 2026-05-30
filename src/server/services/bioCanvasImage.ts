import {
  getImageBlockIds,
  parseBioCanvas,
  parseBioCanvasImageAssets,
  pruneBioCanvasImageAssets,
  type BioCanvasDocument,
  type BioCanvasImageAssets,
} from '@/misc/utils/bioCanvas/index.js';
import cdnService from '@/server/services/core/CdnService.js';
import { logger } from '@/server/services/core/LoggerService.js';

export function canvasHasImageBlocks(doc: BioCanvasDocument | null): boolean {
  return getImageBlockIds(doc).length > 0;
}

export function getReferencedImageBlockIds(doc: BioCanvasDocument | null): Set<string> {
  return new Set(getImageBlockIds(doc));
}

async function deleteCdnAsset(assetId: string): Promise<void> {
  try {
    if (await cdnService.checkFileExists(assetId)) {
      await cdnService.deleteFile(assetId);
    }
  } catch (err) {
    logger.error('Failed to delete bio canvas image from CDN:', err);
  }
}

/**
 * Drop CDN files and map entries for image blocks no longer in the canvas.
 * Returns the pruned assets map, or null if unchanged.
 */
export async function reconcileBioCanvasImageAssets(
  existingAssets: unknown,
  parsedCanvas: BioCanvasDocument | null,
): Promise<BioCanvasImageAssets | null> {
  const assets = parseBioCanvasImageAssets(existingAssets);
  const referenced = getReferencedImageBlockIds(parsedCanvas);
  const next: BioCanvasImageAssets = {};
  let changed = false;

  for (const [blockId, row] of Object.entries(assets)) {
    if (referenced.has(blockId)) {
      next[blockId] = row;
    } else {
      changed = true;
      await deleteCdnAsset(row.assetId);
    }
  }

  if (!changed) return null;
  return next;
}

/** When saved canvas has no image blocks, delete all CDN assets and clear the assets map. */
export async function clearBioCanvasImageAssetsWhenNoImages(
  existingAssets: unknown,
  parsedCanvas: BioCanvasDocument | null,
): Promise<{ bioCanvasImageAssets: null } | null> {
  if (canvasHasImageBlocks(parsedCanvas)) return null;

  const assets = parseBioCanvasImageAssets(existingAssets);
  if (Object.keys(assets).length === 0) return null;

  for (const row of Object.values(assets)) {
    await deleteCdnAsset(row.assetId);
  }

  return { bioCanvasImageAssets: null };
}

/** Upsert one block asset in the map (does not delete previous file — caller handles replacement). */
export function upsertBioCanvasImageAsset(
  existingAssets: unknown,
  blockId: string,
  assetId: string,
  url: string,
): BioCanvasImageAssets {
  const assets = parseBioCanvasImageAssets(existingAssets);
  return { ...assets, [blockId]: { assetId, url } };
}

/** Validate blockId exists in saved or incoming canvas image blocks. */
export function blockIdIsImageBlock(
  canvas: BioCanvasDocument | null,
  blockId: string,
): boolean {
  if (!canvas) return false;
  return getReferencedImageBlockIds(canvas).has(blockId);
}

export { parseBioCanvas, pruneBioCanvasImageAssets };
