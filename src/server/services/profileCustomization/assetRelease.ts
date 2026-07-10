import ProfileCustomizationPiece from '@/models/profile/ProfileCustomizationPiece.js';
import cdnService from '@/server/services/core/CdnService.js';
import { logger } from '@/server/services/core/LoggerService.js';
import {
  extractAssetIdsFromPayload,
  extractAssetIdsFromPieces,
} from '@/server/services/profileCustomization/payloadUtils.js';
import type { ProfileCustomizationUnit } from '@/models/profile/ProfileCustomizationPiece.js';

export async function userReferencesAsset(userId: string, assetId: string): Promise<boolean> {
  const pieces = await ProfileCustomizationPiece.findAll({
    where: { userId },
    attributes: ['unit', 'payload'],
  });
  const referenced = extractAssetIdsFromPieces(
    pieces.map((p) => ({ unit: p.unit, payload: p.payload })),
  );
  return referenced.includes(assetId);
}

export async function releaseUnreferencedAssets(
  userId: string,
  candidateAssetIds: string[],
): Promise<void> {
  const unique = [...new Set(candidateAssetIds.filter((id) => typeof id === 'string' && id.length))];
  if (unique.length === 0) return;

  for (const assetId of unique) {
    try {
      const stillReferenced = await userReferencesAsset(userId, assetId);
      if (stillReferenced) continue;
      if (await cdnService.checkFileExists(assetId)) {
        await cdnService.deleteFile(assetId);
      }
    } catch (err) {
      logger.error('[ProfileCustomization] Failed to release CDN asset', { userId, assetId, err });
    }
  }
}

export async function collectAssetIdsForUser(userId: string): Promise<string[]> {
  const pieces = await ProfileCustomizationPiece.findAll({
    where: { userId },
    attributes: ['unit', 'payload'],
  });
  return extractAssetIdsFromPieces(pieces.map((p) => ({ unit: p.unit, payload: p.payload })));
}

export function diffReleasedAssetIds(
  beforePayload: Record<string, unknown> | null | undefined,
  afterPayload: Record<string, unknown> | null | undefined,
  unit: ProfileCustomizationUnit,
): string[] {
  const before = new Set(extractAssetIdsFromPayload(beforePayload ?? {}, unit));
  const after = new Set(extractAssetIdsFromPayload(afterPayload ?? {}, unit));
  return [...before].filter((id) => !after.has(id));
}
