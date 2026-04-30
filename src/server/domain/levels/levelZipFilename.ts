import Level from '@/models/levels/Level.js';
import { getSongDisplayName, getArtistDisplayName } from '@/misc/utils/data/levelHelpers.js';

/** Build an NFC-normalised UTF-8 zip filename for CDN upload (no hex hack). */
export function encodeLevelZipFilenameForCdn(level: Level): string {
  const song = getSongDisplayName(level) || 'level';
  const artist = getArtistDisplayName(level) || 'unknown';
  const base = `${song} - ${artist}.zip`.replace(/[<>:"/\\|?*]/g, '');
  return base.normalize('NFC');
}
