import type { Request } from 'express';
import type { Model } from 'sequelize';
import {
  BioCanvasError,
  MAX_BIO_CANVAS_BLOCK_ID_LENGTH,
  parseBioCanvas,
  toPlainText,
  type BioCanvasDocument,
  type BioCanvasImageAssets,
} from '@/misc/utils/bioCanvas/index.js';
import {
  blockIdIsImageBlock,
  clearBioCanvasImageAssetsWhenNoImages,
  reconcileBioCanvasImageAssets,
  upsertBioCanvasImageAsset,
} from '@/server/services/bioCanvasImage.js';
import cdnService from '@/server/services/core/CdnService.js';
import { logger } from '@/server/services/core/LoggerService.js';

export function parseBioCanvasBlockId(req: Request): string | null {
  const raw = (req.body as { blockId?: unknown })?.blockId ?? req.query.blockId;
  if (typeof raw !== 'string') return null;
  const blockId = raw.trim();
  if (!blockId.length || blockId.length > MAX_BIO_CANVAS_BLOCK_ID_LENGTH) {
    return null;
  }
  return blockId;
}

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

type BioCanvasRow = Model & {
  id: number;
  bioCanvas?: unknown;
  bioCanvasImageAssets?: unknown;
  bio?: string | null;
};

/** Player or Creator Sequelize model — shared bio canvas persistence surface. */
export type BioCanvasOwnerModel = {
  name: string;
  findByPk(
    id: number,
    options?: { attributes?: string[] },
  ): Promise<BioCanvasRow | null>;
  update(
    values: Record<string, unknown>,
    options: { where: { id: number } },
  ): Promise<unknown>;
};

export async function patchBioCanvasForProfile(
  Model: BioCanvasOwnerModel,
  entityId: number,
  canvasBody: unknown,
): Promise<{
  bioCanvas: Record<string, unknown> | null;
  bioCanvasImageAssets: BioCanvasImageAssets | null;
  bio: string | null;
}> {
  let parsed: BioCanvasDocument | null;
  try {
    parsed = parseBioCanvas(canvasBody);
  } catch (err) {
    const msg = err instanceof BioCanvasError ? err.message : 'Invalid bio canvas';
    throw new BioCanvasProfileError(400, msg);
  }

  const row = await Model.findByPk(entityId, {
    attributes: ['id', 'bioCanvasImageAssets'],
  });
  if (!row) {
    throw new BioCanvasProfileError(404, `${Model.name} not found`);
  }

  const nextBio = toPlainText(parsed);
  const clearedAssets = await clearBioCanvasImageAssetsWhenNoImages(
    row.bioCanvasImageAssets,
    parsed,
  );
  const reconciledAssets = await reconcileBioCanvasImageAssets(row.bioCanvasImageAssets, parsed);

  const updatePayload: Record<string, unknown> = {
    bioCanvas: parsed as unknown as Record<string, unknown> | null,
    bio: nextBio,
    ...(clearedAssets ?? {}),
  };
  if (reconciledAssets !== null) {
    updatePayload.bioCanvasImageAssets = reconciledAssets;
  }

  await Model.update(updatePayload, { where: { id: entityId } });

  const updated = await Model.findByPk(entityId, {
    attributes: ['bioCanvas', 'bioCanvasImageAssets', 'bio'],
  });

  return serializeBioCanvasApiFields({
    bio: updated?.bio,
    bioCanvas: updated?.bioCanvas,
    bioCanvasImageAssets: updated?.bioCanvasImageAssets,
  });
}

export async function uploadBioCanvasImageForProfile(
  Model: BioCanvasOwnerModel,
  entityId: number,
  blockId: string,
  file: Express.Multer.File,
): Promise<{ blockId: string; bioCanvasImageAssets: BioCanvasImageAssets }> {
  const row = await Model.findByPk(entityId, {
    attributes: ['id', 'bioCanvas', 'bioCanvasImageAssets'],
  });
  if (!row) {
    throw new BioCanvasProfileError(404, `${Model.name} not found`);
  }

  let storedCanvas: BioCanvasDocument | null = null;
  try {
    storedCanvas = parseBioCanvas(row.bioCanvas);
  } catch {
    storedCanvas = null;
  }

  if (storedCanvas && !blockIdIsImageBlock(storedCanvas, blockId)) {
    throw new BioCanvasProfileError(
      400,
      'blockId does not match an image block in the saved canvas',
    );
  }

  const result = await cdnService.uploadImage(file.buffer, file.originalname, 'BANNER');
  const displayUrl = result.urls?.large ?? result.urls?.original ?? null;
  if (!displayUrl) {
    throw new BioCanvasProfileError(500, 'CDN did not return image URLs');
  }

  const assets = upsertBioCanvasImageAsset(
    row.bioCanvasImageAssets,
    blockId,
    result.fileId,
    displayUrl,
  );
  const previousAssetId =
    row.bioCanvasImageAssets &&
    typeof row.bioCanvasImageAssets === 'object' &&
    !Array.isArray(row.bioCanvasImageAssets)
      ? (row.bioCanvasImageAssets as Record<string, { assetId?: string }>)[blockId]?.assetId
      : null;

  await Model.update({ bioCanvasImageAssets: assets }, { where: { id: entityId } });

  if (previousAssetId && previousAssetId !== result.fileId) {
    try {
      if (await cdnService.checkFileExists(previousAssetId)) {
        await cdnService.deleteFile(previousAssetId);
      }
    } catch (delErr) {
      logger.error('Error deleting previous bio canvas image from CDN:', delErr);
    }
  }

  return { blockId, bioCanvasImageAssets: assets };
}

export class BioCanvasProfileError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
