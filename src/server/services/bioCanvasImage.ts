import {
  getImageBlockIds,
  parseBioCanvas,
  parseBioCanvasImageAssets,
  pruneBioCanvasImageAssets,
  type BioCanvasDocument,
  type BioCanvasImageAssets,
} from '@/misc/utils/bioCanvas/index.js';

export function canvasHasImageBlocks(doc: BioCanvasDocument | null): boolean {
  return getImageBlockIds(doc).length > 0;
}

export function getReferencedImageBlockIds(doc: BioCanvasDocument | null): Set<string> {
  return new Set(getImageBlockIds(doc));
}

/**
 * Drop map entries for image blocks no longer in the canvas.
 * Returns the pruned assets map, or null if unchanged.
 * CDN cleanup is handled by ProfileCustomizationService.releaseUnreferencedAssets.
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
    }
  }

  if (!changed) return null;
  return next;
}

/** When saved canvas has no image blocks, clear the assets map (no CDN delete here). */
export async function clearBioCanvasImageAssetsWhenNoImages(
  existingAssets: unknown,
  parsedCanvas: BioCanvasDocument | null,
): Promise<{ bioCanvasImageAssets: null } | null> {
  if (canvasHasImageBlocks(parsedCanvas)) return null;

  const assets = parseBioCanvasImageAssets(existingAssets);
  if (Object.keys(assets).length === 0) return null;

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
