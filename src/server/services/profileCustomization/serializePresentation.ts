import type { BioCanvasImageAssets } from '@/misc/utils/bioCanvas/index.js';

export function serializeBioCanvasApiFields(row: {
  bio?: unknown;
  bioCanvas?: unknown;
  bioCanvasImageAssets?: unknown;
}): {
  bio: string | null;
  bioCanvas: Record<string, unknown> | null;
  bioCanvasImageAssets: BioCanvasImageAssets | null;
} {
  return {
    bio: typeof row.bio === 'string' && row.bio.trim().length ? row.bio : null,
    bioCanvas:
      row.bioCanvas && typeof row.bioCanvas === 'object' && !Array.isArray(row.bioCanvas)
        ? (row.bioCanvas as Record<string, unknown>)
        : null,
    bioCanvasImageAssets:
      row.bioCanvasImageAssets &&
      typeof row.bioCanvasImageAssets === 'object' &&
      !Array.isArray(row.bioCanvasImageAssets)
        ? (row.bioCanvasImageAssets as BioCanvasImageAssets)
        : null,
  };
}
