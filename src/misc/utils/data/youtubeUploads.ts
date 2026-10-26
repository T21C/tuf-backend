export const YOUTUBE_UPLOADS_PAGE_SIZE = 50;
export const YOUTUBE_UPLOADS_MAX_SCAN_PAGES = 3;

export type YoutubeUploadPrivacy = 'public' | 'unlisted';

export interface YoutubeUploadVideo {
  videoId: string;
  title: string;
  publishedAt: string | null;
  thumbnailUrl: string | null;
  url: string;
  privacyStatus: YoutubeUploadPrivacy;
}

/** Uploads playlist id is the channel id with the `UC` prefix replaced by `UU`. */
export function youtubeUploadsPlaylistId(channelId: string): string | null {
  const id = channelId.trim();
  if (!/^UC[\w-]{10,}$/.test(id)) return null;
  return `UU${id.slice(2)}`;
}

export function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

export function youtubeUploadTitleMatches(title: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return title.toLowerCase().includes(needle);
}

function thumbnailUrl(thumbnails: unknown): string | null {
  if (!thumbnails || typeof thumbnails !== 'object') return null;
  const sizes = thumbnails as Record<string, {url?: unknown} | undefined>;
  for (const key of ['medium', 'high', 'default', 'standard', 'maxres']) {
    const url = sizes[key]?.url;
    if (typeof url === 'string' && url.trim()) return url.trim();
  }
  return null;
}

export function parseYoutubeUploadItem(item: unknown): YoutubeUploadVideo | null {
  if (!item || typeof item !== 'object') return null;
  const row = item as {
    snippet?: {
      title?: unknown;
      publishedAt?: unknown;
      thumbnails?: unknown;
      resourceId?: {videoId?: unknown};
    };
    status?: {privacyStatus?: unknown};
  };
  const privacy = row.status?.privacyStatus;
  if (privacy !== 'public' && privacy !== 'unlisted') return null;
  const videoIdRaw = row.snippet?.resourceId?.videoId;
  const videoId = typeof videoIdRaw === 'string' ? videoIdRaw.trim() : '';
  if (!videoId) return null;
  const title = typeof row.snippet?.title === 'string' ? row.snippet.title.trim() : '';
  if (!title || title === 'Private video' || title === 'Deleted video') return null;
  const publishedAt =
    typeof row.snippet?.publishedAt === 'string' && row.snippet.publishedAt.trim()
      ? row.snippet.publishedAt
      : null;
  return {
    videoId,
    title,
    publishedAt,
    thumbnailUrl: thumbnailUrl(row.snippet?.thumbnails),
    url: youtubeWatchUrl(videoId),
    privacyStatus: privacy,
  };
}

/** Drop private videos and rows that have no watchable id. */
export function parseYoutubeUploadItems(items: unknown): YoutubeUploadVideo[] {
  if (!Array.isArray(items)) return [];
  const videos: YoutubeUploadVideo[] = [];
  for (const item of items) {
    const parsed = parseYoutubeUploadItem(item);
    if (parsed) videos.push(parsed);
  }
  return videos;
}
