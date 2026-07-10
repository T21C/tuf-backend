import type { BioCanvasImageAssets } from '@/misc/utils/bioCanvas/index.js';
import type { ProfileHeaderSurfaceImageAssets } from '@/misc/utils/profileHeaderSurfaceStyle.js';
import { normalizeTufStellarIconVariant } from '@/misc/utils/subscriptions/tufStellarSubscription.js';
import type {
  ProfileCustomizationPayload,
  ProfileCustomizationUnit,
} from '@/models/profile/ProfileCustomizationPiece.js';
import type {
  AssembledPresentation,
  PresentationSyncState,
} from '@/server/services/profileCustomization/types.js';
import { EMPTY_ASSEMBLED_PRESENTATION } from '@/server/services/profileCustomization/types.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseImageAssetMap(raw: unknown): Record<string, { assetId: string; url: string }> | null {
  if (!isObject(raw)) return null;
  const out: Record<string, { assetId: string; url: string }> = {};
  for (const [key, row] of Object.entries(raw)) {
    if (!isObject(row)) continue;
    const assetId = typeof row.assetId === 'string' ? row.assetId.trim() : '';
    const url = typeof row.url === 'string' ? row.url.trim() : '';
    if (assetId.length && url.length) {
      out[key] = { assetId, url };
    }
  }
  return Object.keys(out).length ? out : null;
}

export function extractAssetIdsFromPayload(
  payload: ProfileCustomizationPayload | null | undefined,
  unit: ProfileCustomizationUnit,
): string[] {
  if (!payload || !isObject(payload)) return [];
  const ids = new Set<string>();

  if (unit === 'banner') {
    const id = typeof payload.customBannerId === 'string' ? payload.customBannerId.trim() : '';
    if (id.length) ids.add(id);
  }

  if (unit === 'header_surface') {
    const map = parseImageAssetMap(payload.profileHeaderSurfaceImageAssets);
    if (map) {
      for (const row of Object.values(map)) {
        ids.add(row.assetId);
      }
    }
  }

  if (unit === 'bio') {
    const map = parseImageAssetMap(payload.bioCanvasImageAssets);
    if (map) {
      for (const row of Object.values(map)) {
        ids.add(row.assetId);
      }
    }
  }

  return [...ids];
}

export function extractAssetIdsFromPieces(
  payloads: Array<{ unit: ProfileCustomizationUnit; payload: ProfileCustomizationPayload }>,
): string[] {
  const ids = new Set<string>();
  for (const row of payloads) {
    for (const id of extractAssetIdsFromPayload(row.payload, row.unit)) {
      ids.add(id);
    }
  }
  return [...ids];
}

export function assemblePresentationFromPieces(
  pieces: Array<{ unit: ProfileCustomizationUnit; payload: ProfileCustomizationPayload }>,
): AssembledPresentation {
  const out = { ...EMPTY_ASSEMBLED_PRESENTATION };

  for (const piece of pieces) {
    const p = piece.payload;
    if (!isObject(p)) continue;

    switch (piece.unit) {
      case 'banner':
        out.bannerPreset =
          typeof p.bannerPreset === 'string' && p.bannerPreset.length ? p.bannerPreset : null;
        out.customBannerId =
          typeof p.customBannerId === 'string' && p.customBannerId.length ? p.customBannerId : null;
        out.customBannerUrl =
          typeof p.customBannerUrl === 'string' && p.customBannerUrl.length ? p.customBannerUrl : null;
        break;
      case 'header_surface':
        out.profileHeaderSurfaceStyle = isObject(p.profileHeaderSurfaceStyle)
          ? (p.profileHeaderSurfaceStyle as Record<string, unknown>)
          : null;
        out.profileHeaderSurfaceImageAssets = parseImageAssetMap(
          p.profileHeaderSurfaceImageAssets,
        ) as ProfileHeaderSurfaceImageAssets | null;
        break;
      case 'bio':
        out.bio = typeof p.bio === 'string' && p.bio.trim().length ? p.bio : null;
        out.bioCanvas = isObject(p.bioCanvas) ? (p.bioCanvas as Record<string, unknown>) : null;
        out.bioCanvasImageAssets = parseImageAssetMap(
          p.bioCanvasImageAssets,
        ) as BioCanvasImageAssets | null;
        break;
      case 'stellar_icon':
        out.tufStellarIconVariant = normalizeTufStellarIconVariant(p.tufStellarIconVariant);
        break;
      default:
        break;
    }
  }

  return out;
}

export function buildBannerPayload(row: {
  bannerPreset?: unknown;
  customBannerId?: unknown;
  customBannerUrl?: unknown;
}): ProfileCustomizationPayload | null {
  const bannerPreset =
    typeof row.bannerPreset === 'string' && row.bannerPreset.length ? row.bannerPreset : null;
  const customBannerId =
    typeof row.customBannerId === 'string' && row.customBannerId.length ? row.customBannerId : null;
  const customBannerUrl =
    typeof row.customBannerUrl === 'string' && row.customBannerUrl.length ? row.customBannerUrl : null;
  if (!bannerPreset && !customBannerId && !customBannerUrl) return null;
  return { bannerPreset, customBannerId, customBannerUrl };
}

export function buildHeaderSurfacePayload(row: {
  profileHeaderSurfaceStyle?: unknown;
  profileHeaderSurfaceImageAssets?: unknown;
}): ProfileCustomizationPayload | null {
  const profileHeaderSurfaceStyle = isObject(row.profileHeaderSurfaceStyle)
    ? row.profileHeaderSurfaceStyle
    : null;
  const profileHeaderSurfaceImageAssets = parseImageAssetMap(row.profileHeaderSurfaceImageAssets);
  if (!profileHeaderSurfaceStyle && !profileHeaderSurfaceImageAssets) return null;
  return { profileHeaderSurfaceStyle, profileHeaderSurfaceImageAssets };
}

export function buildBioPayload(row: {
  bio?: unknown;
  bioCanvas?: unknown;
  bioCanvasImageAssets?: unknown;
}): ProfileCustomizationPayload | null {
  const bio = typeof row.bio === 'string' && row.bio.trim().length ? row.bio.trim() : null;
  const bioCanvas = isObject(row.bioCanvas) ? row.bioCanvas : null;
  const bioCanvasImageAssets = parseImageAssetMap(row.bioCanvasImageAssets);
  if (!bio && !bioCanvas && !bioCanvasImageAssets) return null;
  return { bio, bioCanvas, bioCanvasImageAssets };
}

export function buildStellarPayload(row: { tufStellarIconVariant?: unknown }): ProfileCustomizationPayload {
  return { tufStellarIconVariant: normalizeTufStellarIconVariant(row.tufStellarIconVariant) };
}

export function isPieceLinked(piece: {
  playerId: number | null;
  creatorId: number | null;
}): boolean {
  return piece.playerId != null && piece.creatorId != null;
}

export function buildPresentationSyncMap(
  pieces: Array<{
    unit: ProfileCustomizationUnit;
    playerId: number | null;
    creatorId: number | null;
  }>,
): Record<ProfileCustomizationUnit, PresentationSyncState> {
  const map: Record<ProfileCustomizationUnit, PresentationSyncState> = {
    banner: 'missing',
    header_surface: 'missing',
    bio: 'missing',
    stellar_icon: 'missing',
  };
  for (const piece of pieces) {
    map[piece.unit] = isPieceLinked(piece) ? 'linked' : 'independent';
  }
  return map;
}
