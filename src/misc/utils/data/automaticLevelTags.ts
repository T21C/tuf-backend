/**
 * Tags the level parser assigns from the chart file itself.
 * Nobody can grant or remove these by request; a file change and a reparse can.
 */

export enum VFX_TIERS {
  None,
  Low,
  Camera,
  Filter,
  Deco,
  Full,
}

/** Shorter charts are not tagged. Only these thresholds are parser-owned. */
export const lengthTagsMinutes: Record<number, string> = {
  30: '30+ Minutes',
  45: '45+ Minutes',
  60: '1+ Hours',
  90: '1.5+ Hours',
  120: '2+ Hours',
  360: 'Timeless',
};

export const vfxTierTags: Record<number, string> = {
  [VFX_TIERS.None]: 'Non-VFX',
  [VFX_TIERS.Low]: 'Low VFX',
  [VFX_TIERS.Camera]: 'Camera',
  [VFX_TIERS.Filter]: 'Filters',
  [VFX_TIERS.Deco]: 'Decorations',
  [VFX_TIERS.Full]: 'Full VFX',
};

export const dlcTagsMap: Record<string, string> = {
  containsDLC: 'DLC',
  Hold: 'Hold',
  MultiPlanet: 'Multi Planet',
  FreeRoam: 'Free Roam',
  ScaleMargin: 'Timing Window Scale',
};

export const requiredModsTagsMap: Record<string, string> = {
  YouTubeStream: 'Youtube Stream',
  KeyLimiter: 'Key Limiter',
  PACL2: 'PACL2',
};

export const miscTagsMap: Record<string, string> = {
  isJudgementLimited: 'Judgement Limit',
  autoTile: 'Auto Tile',
};

export const AUTOMATIC_LEVEL_TAG_NAMES: ReadonlySet<string> = new Set([
  ...Object.values(lengthTagsMinutes),
  ...Object.values(vfxTierTags),
  ...Object.values(dlcTagsMap),
  ...Object.values(requiredModsTagsMap),
  ...Object.values(miscTagsMap),
]);

export function isAutomaticLevelTagName(name: unknown): boolean {
  return typeof name === 'string' && AUTOMATIC_LEVEL_TAG_NAMES.has(name);
}
