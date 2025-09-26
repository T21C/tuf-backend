export {default as LevelPack} from './LevelPack.js';
export {default as LevelPackItem} from './LevelPackItem.js';
export {default as PackFolder} from './PackFolder.js';

export type {ILevelPack} from './LevelPack.js';
export type {ILevelPackItem} from './LevelPackItem.js';
export type {IPackFolder} from './PackFolder.js';

export const LevelPackViewModes = {
  PUBLIC: 1,
  LINKONLY: 2,
  PRIVATE: 3,
  FORCED_PRIVATE: 4
} as const;

export const LevelPackCSSFlags = {
  THEME_DEFAULT: 0,
  THEME_DARK: 1,
  THEME_NEON: 2,
  THEME_PASTEL: 3,
  CUSTOM_BACKGROUND: 4,
  CUSTOM_BORDERS: 5,
  CUSTOM_SHADOWS: 6
} as const;
