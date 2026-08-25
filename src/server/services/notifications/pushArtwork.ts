import {getPrimaryVideoLink} from '@/misc/utils/data/videoLinkParts.js';
import {clientUrlEnv} from '@/config/app.config.js';
import Level from '@/models/levels/Level.js';
import Difficulty from '@/models/levels/Difficulty.js';

const YOUTUBE_ID =
  /(?:youtube\.com\/(?:watch\?v=|live\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;

export function youtubeThumbnailUrl(videoLink: string | null | undefined): string | null {
  const primary = getPrimaryVideoLink(videoLink);
  if (!primary) return null;
  const match = primary.match(YOUTUBE_ID);
  const id = match?.[1];
  if (!id) return null;
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

export function toAbsoluteAssetUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const origin = String(clientUrlEnv || '').replace(/\/$/, '');
  if (!origin) return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return `${origin}${trimmed.startsWith('/') ? trimmed : `/${trimmed}`}`;
}

export function siteFaviconUrl(): string | null {
  return toAbsoluteAssetUrl('/favicon.ico');
}

export async function resolvePushArtwork(payload: unknown): Promise<{
  image: string | null;
  icon: string | null;
}> {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const levelId = Number(record.levelId);
  if (!Number.isInteger(levelId) || levelId <= 0) {
    return {image: null, icon: siteFaviconUrl()};
  }
  const level = await Level.findByPk(levelId, {
    attributes: ['id', 'videoLink'],
    include: [{model: Difficulty, as: 'difficulty', attributes: ['icon'], required: false}],
  });
  const image = youtubeThumbnailUrl(level?.videoLink) ?? null;
  const icon = toAbsoluteAssetUrl(level?.difficulty?.icon) ?? siteFaviconUrl();
  return {image, icon};
}
