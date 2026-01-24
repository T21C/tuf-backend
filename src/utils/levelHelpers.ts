/**
 * Level dependency pipeline utilities
 * Provides backward compatibility for levels that haven't been migrated yet
 * Pattern: newObject || oldProperty
 */

import Level from '../models/levels/Level.js';

/**
 * Get song name from level with fallback
 * @param level - Level instance or plain object
 * @returns Song name or empty string
 */
export const getSongName = (level: Level | any): string => {
  if (!level) return '';
  return level.songs?.[0]?.name || level.song || '';
};

/**
 * Get artist object from level with fallback
 * Returns the full artistObject if available, otherwise creates a minimal object from legacy artist string
 * @param level - Level instance or plain object
 * @returns Artist object or null
 */
export const getArtists = (level: Level | any): any | null => {
  if (!level) return null;
  if (level.artists) return level.artists;
  if (level.artist) {
    return {
      id: level.artistId || null,
      name: level.artist
    };
  }
  return null;
};

/**
 * Get full song display name with suffix if applicable
 * @param level - Level instance or plain object
 * @returns Song name with suffix or just song name
 */
export const getSongDisplayName = (level: Level | any): string => {
  if (!level) return '';
  const songName = getSongName(level);
  if (level.suffix && songName) {
    return `${songName} (${level.suffix})`;
  }
  return songName;
};
