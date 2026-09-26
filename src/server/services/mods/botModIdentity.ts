import {createHash} from 'node:crypto';
import {snapshotDescription, snapshotDownloadUrl, snapshotVersion} from './botModDiff.js';

/**
 * The bot feed has no stable mod id. `_id` and `id` identify a single upload.
 * The same mod is every row that shares a name, and each of those rows is a release.
 * This hash is only a URL-safe primary key derived from that name.
 * Keep it in sync with migrations/1790433647_bot_mods_name_identity.cjs.
 */
export function botModIdFromName(name: string): string {
  return createHash('sha256').update(name).digest('hex');
}

export type BotModFeedRow = {
  id: string;
  sourceMongoId: string | null;
  name: string;
  version: string | null;
  parsedDownload: string | null;
  download: string | null;
  description: string | null;
  cachedUsername: string;
  creatorDiscordId: string;
  uploadedAt: Date | null;
  ignoreUpdate: boolean;
  hideFromSearch: boolean;
  lastSeenAt: Date;
  missingSince: null;
  updatedAt: Date;
};

export type BotModFeedRelease = {
  botId: string;
  version: string;
  parsedDownload: string;
  download: string | null;
  description: string | null;
  uploadedAt: Date | null;
};

export type GroupedBotModFeed = BotModFeedRow & {
  releases: BotModFeedRelease[];
};

function uploadedTime(value: Date | null | undefined): number {
  if (!(value instanceof Date)) return Number.NEGATIVE_INFINITY;
  const time = value.getTime();
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

export function groupFeedMods(items: BotModFeedRow[]): GroupedBotModFeed[] {
  const byName = new Map<string, BotModFeedRow[]>();
  for (const item of items) {
    const name = item.name.trim();
    if (!name) continue;
    const list = byName.get(name);
    if (list) list.push(item);
    else byName.set(name, [item]);
  }

  const grouped: GroupedBotModFeed[] = [];
  for (const [name, entries] of byName) {
    const latest = entries.reduce((best, item) =>
      uploadedTime(item.uploadedAt) >= uploadedTime(best.uploadedAt) ? item : best,
    );
    const id = botModIdFromName(name);
    const byVersion = new Map<string, BotModFeedRelease>();
    for (const item of entries) {
      const version = snapshotVersion(item.version);
      const parsedDownload = snapshotDownloadUrl(item.parsedDownload);
      if (!version || !parsedDownload) continue;
      const next: BotModFeedRelease = {
        botId: id,
        version,
        parsedDownload,
        download: snapshotDownloadUrl(item.download) || null,
        description: snapshotDescription(item.description),
        uploadedAt: item.uploadedAt,
      };
      const prev = byVersion.get(version);
      if (!prev || uploadedTime(next.uploadedAt) >= uploadedTime(prev.uploadedAt)) {
        byVersion.set(version, next);
      }
    }
    const releases = [...byVersion.values()].sort((a, b) => {
      const delta = uploadedTime(a.uploadedAt) - uploadedTime(b.uploadedAt);
      if (delta !== 0) return delta;
      return a.version.localeCompare(b.version);
    });
    grouped.push({
      ...latest,
      id,
      name,
      releases,
    });
  }
  return grouped;
}
