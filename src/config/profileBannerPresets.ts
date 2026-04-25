import bannerPresetManifest from './bannerPresetManifest.json';

export type BannerPresetManifest = {
  version: number;
  generatedAt: string;
  presets: string[];
};

export const bannerPresetManifestTyped = bannerPresetManifest as BannerPresetManifest;

/** Allowlist synced by `client/scripts/generateBannerManifest.mjs` from `client/public/banners`. */
export function getAllowedBannerPresetSet(): ReadonlySet<string> {
  return new Set(bannerPresetManifestTyped.presets);
}

export const DEFAULT_PROFILE_BANNER_PRESET = 'banners/default.svg';
