import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type BannerPresetManifest = {
  version: number;
  generatedAt: string;
  presets: string[];
};

let manifestCache: BannerPresetManifest | null = null;

function readBannerPresetManifest(): BannerPresetManifest {
  if (manifestCache) {
    return manifestCache;
  }

  const dir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(dir, 'bannerPresetManifest.json'),
    path.join(dir, '..', '..', 'src', 'config', 'bannerPresetManifest.json'),
  ];

  for (const manifestPath of candidates) {
    if (!existsSync(manifestPath)) continue;
    const raw = readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as BannerPresetManifest;
    if (!parsed || !Array.isArray(parsed.presets)) {
      throw new Error(`Invalid banner preset manifest: ${manifestPath}`);
    }
    manifestCache = parsed;
    return parsed;
  }

  throw new Error(
    'bannerPresetManifest.json not found (tried next to this module and server/src/config). Run `npm run generate:banners` in client.',
  );
}

/** Allowlist synced by `client/scripts/generateBannerManifest.mjs` from `client/public/banners`. */
export function getAllowedBannerPresetSet(): ReadonlySet<string> {
  return new Set(readBannerPresetManifest().presets);
}

export const DEFAULT_PROFILE_BANNER_PRESET = 'banners/default.svg';
