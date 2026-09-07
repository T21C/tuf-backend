export type YoutubeVideoMatch = 'submitter' | 'player' | null;

export type YoutubeLinkConflict = 'already_linked_self' | 'already_linked_other' | null;

export interface YoutubeChannelPublic {
  channelId: string;
  title: string;
  handle: string | null;
  isPrimary: boolean;
  url: string;
}

/**
 * YouTube `snippet.customUrl` may be `@handle`, a bare handle, or a legacy
 * `/c/` / `/user/` path. Only a handle without slashes is stored.
 */
export function normalizeYoutubeHandle(customUrl: unknown): string | null {
  if (typeof customUrl !== 'string') return null;
  let value = customUrl.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) {
    try {
      value = new URL(value).pathname.replace(/^\/+/, '');
    } catch {
      return null;
    }
  }
  value = value.replace(/^@/, '').trim();
  if (!value || value.includes('/')) return null;
  return value;
}

export function youtubeChannelUrl(channel: {
  channelId: string;
  handle?: string | null;
}): string {
  const handle = typeof channel.handle === 'string' ? channel.handle.trim() : '';
  if (handle) {
    return `https://www.youtube.com/@${handle.replace(/^@/, '')}`;
  }
  return `https://www.youtube.com/channel/${channel.channelId}`;
}

export function serializeYoutubeChannel(row: {
  channelId: string;
  title: string;
  handle: string | null;
  isPrimary: boolean;
}): YoutubeChannelPublic {
  return {
    channelId: row.channelId,
    title: row.title,
    handle: row.handle,
    isPrimary: row.isPrimary,
    url: youtubeChannelUrl(row),
  };
}

export function youtubeLinkConflict(
  existing: {userId: string} | null | undefined,
  userId: string,
): YoutubeLinkConflict {
  if (!existing) return null;
  return existing.userId === userId ? 'already_linked_self' : 'already_linked_other';
}

export function shouldBePrimaryOnInsert(existingCountForUser: number): boolean {
  return existingCountForUser <= 0;
}

export function nextPrimaryChannelId(
  unlinked: {channelId: string; isPrimary: boolean},
  remaining: Array<{channelId: string; createdAt: Date}>,
): string | null {
  if (!unlinked.isPrimary || remaining.length === 0) return null;
  const sorted = [...remaining].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  return sorted[0]?.channelId ?? null;
}

/**
 * Green (submitter) wins when both the submitter and assigned player match.
 */
export function resolveYoutubeVideoMatch(args: {
  videoChannelId: string | null | undefined;
  submitterChannelIds: readonly string[];
  assignedPlayerChannelIds?: readonly string[];
}): YoutubeVideoMatch {
  const id =
    typeof args.videoChannelId === 'string' ? args.videoChannelId.trim() : '';
  if (!id) return null;
  if (args.submitterChannelIds.includes(id)) return 'submitter';
  if (args.assignedPlayerChannelIds?.includes(id)) return 'player';
  return null;
}
