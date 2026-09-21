import twemoji from 'twemoji';
import { getVideoProvider, getPrimaryVideoLink } from '@/misc/utils/data/videoLinkParts.js';
import { getYouTubeVideoDetails } from '@/misc/utils/data/youtubeVideoDetails.js';
import { getBilibiliVideoDetails } from '@/misc/utils/data/bilibiliVideoDetails.js';
import type { VideoDetails } from '@/misc/utils/data/videoDetailTypes.js';

export type { VideoDetails } from '@/misc/utils/data/videoDetailTypes.js';

/**
 * Metadata for write paths (submit time, Discord). Host decides which module runs.
 * YouTube and Bilibili do not fall through into each other.
 */
async function getVideoDetails(url: string): Promise<VideoDetails | null> {
  const primary = getPrimaryVideoLink(url);
  if (!primary) return null;

  const provider = getVideoProvider(primary);
  if (provider === 'youtube') return getYouTubeVideoDetails(primary);
  if (provider === 'bilibili') return getBilibiliVideoDetails(primary);
  return null;
}

function isoToEmoji(code: string): string | null {
  const htmlString = twemoji.parse(
    code
      .toLowerCase()
      .split('')
      .map((letter: string) => (letter.charCodeAt(0) % 32) + 0x1f1e5)
      .map((n: number) => String.fromCodePoint(n))
      .join(''),
  );

  const srcRegex = /src\s*=\s*"(.+?)"/;
  const match = htmlString.match(srcRegex);

  return match ? match[1] : null;
}

export {
  getYouTubeVideoDetails,
  getBilibiliVideoDetails,
  isoToEmoji,
  getVideoDetails,
};
