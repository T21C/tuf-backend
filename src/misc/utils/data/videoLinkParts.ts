/**
 * Level/pass `videoLink` fields may store multiple URLs separated by whitespace.
 * The first link is the primary showcase video; additional links are searchable
 * aliases (`videolink:<url>`) but must not drive embeds or metadata.
 */

export function splitVideoLinks(raw: string | null | undefined): string[] {
  if (raw == null || typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  return trimmed.split(/\s+/).filter(Boolean);
}

export function getPrimaryVideoLink(raw: string | null | undefined): string {
  return splitVideoLinks(raw)[0] ?? '';
}

const VIDEO_HOST_PATTERNS: Array<{ host: RegExp; label: 'youtube' | 'bilibili' }> = [
  { host: /(^|\.)youtube\.com$|(^|\.)youtube-nocookie\.com$|(^|\.)youtu\.be$/i, label: 'youtube' },
  { host: /(^|\.)bilibili\.com$|(^|\.)b23\.tv$/i, label: 'bilibili' },
];

/** Host of the primary link. YouTube and Bilibili never share a match. */
export function getVideoProvider(url: string | null | undefined): 'youtube' | 'bilibili' | null {
  const primary = getPrimaryVideoLink(url);
  if (!primary) return null;
  try {
    const host = new URL(primary).hostname.replace(/^www\./i, '');
    for (const row of VIDEO_HOST_PATTERNS) {
      if (row.host.test(host)) return row.label;
    }
    return null;
  } catch {
    return null;
  }
}

const YOUTUBE_ID_PATTERNS = [
  /youtu\.be\/([a-zA-Z0-9_-]{11})/,
  /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
  /youtube\.com\/live\/([a-zA-Z0-9_-]{11})/,
  /youtube(?:-nocookie)?\.com\/embed\/([a-zA-Z0-9_-]{11})/,
  /[?&]v=([a-zA-Z0-9_-]{11})/,
];

/** Extract an 11-character YouTube video id from common watch/short/embed URLs. */
export function extractYouTubeVideoId(url: string | null | undefined): string | null {
  const primary = getPrimaryVideoLink(url);
  if (!primary || getVideoProvider(primary) !== 'youtube') return null;
  for (const pattern of YOUTUBE_ID_PATTERNS) {
    const match = primary.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** Build a YouTube iframe embed URL without hitting the video details API. */
export function getYouTubeEmbedUrl(url: string | null | undefined): string | null {
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) return null;

  const primary = getPrimaryVideoLink(url);
  const timestampMatch = primary.match(/[?&]t=(\d+)s?/);
  const timestamp = timestampMatch?.[1] ?? null;
  let embedUrl = `https://www.youtube.com/embed/${videoId}`;
  if (timestamp) {
    embedUrl += `?start=${timestamp}`;
  }
  return embedUrl;
}

/** Thumbnail for YouTube links without API calls. */
export function getYouTubeThumbnailUrl(url: string | null | undefined): string | null {
  const videoId = extractYouTubeVideoId(url);
  return videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : null;
}

/** Extract a Bilibili BV id from a video or b23 URL. */
export function extractBilibiliBvId(url: string | null | undefined): string | null {
  const primary = getPrimaryVideoLink(url);
  if (!primary || getVideoProvider(primary) !== 'bilibili') return null;
  const match = primary.match(/\/(BV[a-zA-Z0-9]+)/);
  return match?.[1] ?? null;
}

/** Build a Bilibili iframe embed URL from BV id only (no cid / API). */
export function getBilibiliEmbedUrl(url: string | null | undefined): string | null {
  const bvid = extractBilibiliBvId(url);
  if (!bvid) return null;
  return `https://player.bilibili.com/player.html?isOutside=true&bvid=${bvid}&p=1&autoplay=0`;
}

/**
 * Canonicalise a single video URL to a stable form. Unknown URLs pass through unchanged.
 */
export function cleanSingleVideoUrl(url: string): string {
  if (!url || typeof url !== 'string') return '';

  const patterns = [
    /https?:\/\/(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/,
    /https?:\/\/(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]+)/,
    /https?:\/\/(?:www\.)?youtube\.com\/live\/([a-zA-Z0-9_-]+)/,
    /https?:\/\/(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/,
    /https?:\/\/(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]+)/,
    /https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/(BV[a-zA-Z0-9]+)/,
    /https?:\/\/(?:www\.|m\.)?b23\.tv\/(BV[a-zA-Z0-9]+)/,
    /https?:\/\/(?:www\.|m\.)?bilibili\.com\/.*?(BV[a-zA-Z0-9]+)/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match?.[1]) {
      if (match[1].startsWith('BV')) {
        return `https://www.bilibili.com/video/${match[1]}`;
      }
      return `https://www.youtube.com/watch?v=${match[1]}`;
    }
  }

  return url;
}

/** Canonicalise each whitespace-separated video URL; preserves multi-link strings. */
export function cleanVideoLinks(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  const parts = splitVideoLinks(raw);
  if (parts.length === 0) return '';
  return parts.map(cleanSingleVideoUrl).join(' ');
}
