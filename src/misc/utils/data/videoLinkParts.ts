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

/**
 * Canonicalise a single video URL to a stable form. Unknown URLs pass through unchanged.
 */
export function cleanSingleVideoUrl(url: string): string {
  if (!url || typeof url !== 'string') return '';

  const patterns = [
    /https?:\/\/(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/,
    /https?:\/\/(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]+)/,
    /https?:\/\/(?:www\.)?youtube\.com\/live\/([a-zA-Z0-9_-]+)/,
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
