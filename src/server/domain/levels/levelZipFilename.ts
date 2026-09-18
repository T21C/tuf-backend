import Level from '@/models/levels/Level.js';
import { getSongDisplayName, getArtistDisplayName } from '@/misc/utils/data/levelHelpers.js';
import { normaliseOriginalName } from '@/server/services/upload/UploadSessionService.js';

/** Build an NFC-normalised UTF-8 zip filename for CDN upload (no hex hack). */
export function encodeZipFilenameForCdn(
  song: string | null | undefined,
  artist: string | null | undefined,
): string {
  const songName = (typeof song === 'string' && song.trim()) || 'level';
  const artistName = (typeof artist === 'string' && artist.trim()) || 'unknown';
  const base = `${songName} - ${artistName}.zip`.replace(/[<>:"/\\|?*]/g, '');
  return normaliseOriginalName(base.normalize('NFC'));
}

export function encodeLevelZipFilenameForCdn(level: Level): string {
  return encodeZipFilenameForCdn(getSongDisplayName(level), getArtistDisplayName(level));
}
