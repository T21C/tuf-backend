import type { Request } from 'express';
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
import {
  getPieceForEntity,
  patchPiecePayloadForEntity,
  type ProfileEntityKind,
} from '@/server/services/profileCustomization/ProfileCustomizationService.js';
import { reindexProfilesForIds } from '@/server/services/profileCustomization/reindexProfiles.js';
import { serializeBioCanvasApiFields } from '@/server/services/profileCustomization/serializePresentation.js';

export { serializeBioCanvasApiFields };

export function parseBioCanvasBlockId(req: Request): string | null {
  const raw = (req.body as { blockId?: unknown })?.blockId ?? req.query.blockId;
  if (typeof raw !== 'string') return null;
  const blockId = raw.trim();
  if (!blockId.length || blockId.length > MAX_BIO_CANVAS_BLOCK_ID_LENGTH) {
    return null;
  }
  return blockId;
}

function bioPayloadFromPiece(payload: Record<string, unknown>) {
  return {
    bio: payload.bio,
    bioCanvas: payload.bioCanvas,
    bioCanvasImageAssets: payload.bioCanvasImageAssets,
  };
}

export async function patchBioCanvasForEntity(
  entityKind: ProfileEntityKind,
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

  const existingPiece = await getPieceForEntity(entityKind, entityId, 'bio');
  const existingPayload = existingPiece?.payload ?? {};
  const existingAssets = existingPayload.bioCanvasImageAssets;

  const nextBio = toPlainText(parsed);
  const clearedAssets = await clearBioCanvasImageAssetsWhenNoImages(existingAssets, parsed);
  const reconciledAssets = await reconcileBioCanvasImageAssets(existingAssets, parsed);

  let nextAssets: BioCanvasImageAssets | null =
    existingAssets && typeof existingAssets === 'object' && !Array.isArray(existingAssets)
      ? (existingAssets as BioCanvasImageAssets)
      : null;
  if (clearedAssets?.bioCanvasImageAssets === null) {
    nextAssets = null;
  } else if (reconciledAssets !== null) {
    nextAssets = reconciledAssets;
  }

  const nextPayload = {
    ...existingPayload,
    bioCanvas: parsed as unknown as Record<string, unknown> | null,
    bio: nextBio,
    bioCanvasImageAssets: nextAssets,
  };

  const piece = await patchPiecePayloadForEntity(entityKind, entityId, 'bio', () => nextPayload);
  await reindexProfilesForIds({
    playerIds: entityKind === 'player' || piece.playerId ? [piece.playerId ?? entityId].filter(Boolean) as number[] : [],
    creatorIds: entityKind === 'creator' || piece.creatorId ? [piece.creatorId ?? entityId].filter(Boolean) as number[] : [],
  });

  return serializeBioCanvasApiFields(bioPayloadFromPiece(piece.payload));
}

export async function uploadBioCanvasImageForEntity(
  entityKind: ProfileEntityKind,
  entityId: number,
  blockId: string,
  file: Express.Multer.File,
): Promise<{ blockId: string; bioCanvasImageAssets: BioCanvasImageAssets }> {
  const existingPiece = await getPieceForEntity(entityKind, entityId, 'bio');
  const existingPayload = existingPiece?.payload ?? {};

  let storedCanvas: BioCanvasDocument | null = null;
  try {
    storedCanvas = parseBioCanvas(existingPayload.bioCanvas);
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
    existingPayload.bioCanvasImageAssets,
    blockId,
    result.fileId,
    displayUrl,
  );

  const piece = await patchPiecePayloadForEntity(entityKind, entityId, 'bio', (current) => ({
    ...current,
    bioCanvasImageAssets: assets,
  }));

  await reindexProfilesForIds({
    playerIds: piece.playerId != null ? [piece.playerId] : entityKind === 'player' ? [entityId] : [],
    creatorIds: piece.creatorId != null ? [piece.creatorId] : entityKind === 'creator' ? [entityId] : [],
  });

  return { blockId, bioCanvasImageAssets: assets };
}

export async function patchPlainBioForEntity(
  entityKind: ProfileEntityKind,
  entityId: number,
  nextBio: string | null,
): Promise<{ bio: string | null }> {
  const piece = await patchPiecePayloadForEntity(entityKind, entityId, 'bio', (current) => ({
    ...current,
    bio: nextBio,
  }));
  await reindexProfilesForIds({
    playerIds: piece.playerId != null ? [piece.playerId] : entityKind === 'player' ? [entityId] : [],
    creatorIds: piece.creatorId != null ? [piece.creatorId] : entityKind === 'creator' ? [entityId] : [],
  });
  return { bio: typeof piece.payload.bio === 'string' ? piece.payload.bio : null };
}

export class BioCanvasProfileError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** @deprecated Use patchBioCanvasForEntity */
export async function patchBioCanvasForProfile(
  Model: { name: string },
  entityId: number,
  canvasBody: unknown,
) {
  const kind: ProfileEntityKind = Model.name === 'Creator' ? 'creator' : 'player';
  return patchBioCanvasForEntity(kind, entityId, canvasBody);
}

/** @deprecated Use uploadBioCanvasImageForEntity */
export async function uploadBioCanvasImageForProfile(
  Model: { name: string },
  entityId: number,
  blockId: string,
  file: Express.Multer.File,
) {
  const kind: ProfileEntityKind = Model.name === 'Creator' ? 'creator' : 'player';
  return uploadBioCanvasImageForEntity(kind, entityId, blockId, file);
}

export type BioCanvasOwnerModel = {
  name: string;
};
