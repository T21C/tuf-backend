import type { ProfileCustomizationUnit } from '@/models/profile/ProfileCustomizationPiece.js';

export type PresentationSyncState = 'linked' | 'independent' | 'missing';

export type PresentationSyncMap = Record<ProfileCustomizationUnit, PresentationSyncState>;

export type AssembledPresentation = {
  bio: string | null;
  bioCanvas: Record<string, unknown> | null;
  bioCanvasImageAssets: Record<string, { assetId: string; url: string }> | null;
  bannerPreset: string | null;
  customBannerId: string | null;
  customBannerUrl: string | null;
  profileHeaderSurfaceStyle: Record<string, unknown> | null;
  profileHeaderSurfaceImageAssets: Record<string, { assetId: string; url: string }> | null;
  tufStellarIconVariant: string;
};

export const EMPTY_ASSEMBLED_PRESENTATION: AssembledPresentation = {
  bio: null,
  bioCanvas: null,
  bioCanvasImageAssets: null,
  bannerPreset: null,
  customBannerId: null,
  customBannerUrl: null,
  profileHeaderSurfaceStyle: null,
  profileHeaderSurfaceImageAssets: null,
  tufStellarIconVariant: '1',
};
