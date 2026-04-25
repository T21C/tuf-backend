import {getVideoDetails} from '@/misc/utils/data/videoDetailParser.js';
import {logger} from '@/server/services/core/LoggerService.js';

/**
 * Resolve a chart's logical "published" instant from its showcase `videoLink`, using the same
 * API-backed stack as {@link getVideoDetails} (YouTube Data API + Bilibili view API).
 *
 * Used when ingesting new levels so `levels.createdAt` reflects the video upload time instead of
 * the DB insert clock (which can collapse to a single migration/init timestamp).
 */
export async function resolveLevelCreatedAtFromVideoLink(
  videoLink: string | null | undefined,
): Promise<Date | null> {
  if (videoLink == null || typeof videoLink !== 'string') return null;
  const trimmed = videoLink.trim();
  if (!trimmed) return null;

  try {
    const details = await getVideoDetails(trimmed);
    if (!details?.timestamp) return null;
    const d = new Date(details.timestamp);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch (e) {
    logger.warn('[resolveLevelCreatedAtFromVideoLink] fetch failed', {
      error: e instanceof Error ? e.message : String(e),
      linkSnippet: trimmed.slice(0, 80),
    });
    return null;
  }
}
