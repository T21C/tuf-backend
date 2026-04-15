/**
 * Level dependency pipeline utilities
 * Provides backward compatibility for levels that haven't been migrated yet
 * Pattern: newObject || oldProperty
 */

import Level from '@/models/levels/Level.js';
import Artist from '@/models/artists/Artist.js';

/**
 * Get song name from level with fallback
 * @param level - Level instance or plain object
 * @returns Song name or empty string
 */
export const getSongName = (level: Level | any): string => {
  if (!level) return '';
  return level.songObject?.name || level.song || '';
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
 * Get artist name from level with fallback
 * Prioritizes artists from songObject.artists (direct association), then falls back to level.artists, then level.artist
 * @param level - Level instance or plain object
 * @returns Artist name or empty string
 */
export const getArtistDisplayName = (level: Level | any): string => {
  if (!level) return '';

  // First, try to get artists from songObject.artists (prioritize songObject direct association)
  if (level.songObject?.artists && Array.isArray(level.songObject.artists)) {
    const artistNames = level.songObject.artists
      .map((artist: Artist) => artist.name)
      .filter((name: string | undefined): name is string => !!name);
    if (artistNames.length > 0) {
      return artistNames.join(' & ');
    }
  }

  // Fallback to level.artists if available
  if (level.artists && Array.isArray(level.artists)) {
    const artistNames = level.artists.map((artist: Artist) => artist.name).filter(Boolean);
    if (artistNames.length > 0) {
      return artistNames.join(' & ');
    }
  }

  // Final fallback to legacy level.artist field
  return level.artist || '';
};


/**
 * Get full song display name with suffix if applicable
 * @param level - Level instance or plain object
 * @returns Song name with suffix or just song name
 */
export const getSongDisplayName = (level: Level | any): string => {
  if (!level) return '';
  const songName = getSongName(level);
  if (level.suffix && songName && level.songObject) {
    return `${songName} ${level.suffix}`;
  } else {
    return songName;
  }
};

export const formatDuration = (duration: number): string => {
  if (!duration) return '';
  const hours = Math.floor(duration / 3600000);
  const minutes = Math.floor((duration % 3600000) / 60000);
  const seconds = Math.floor((duration % 60000) / 1000);
  const timeArray = [
    hours > 0 ? hours.toString() : '', 
    minutes.toString().padStart(2, '0'), 
    seconds.toString().padStart(2, '0'),
  ];
  return timeArray.filter(time => time !== '').join(':');
};