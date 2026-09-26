import axios from 'axios';
import {Op, type WhereOptions} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import BotMod from '@/models/misc/BotMod.js';
import BotModLink from '@/models/misc/BotModLink.js';
import BotModRelease from '@/models/misc/BotModRelease.js';
import Mod from '@/models/misc/Mod.js';
import ModVersion from '@/models/misc/ModVersion.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {invalidatePublicModsCache} from './modCache.js';
import {createModVersion} from './modCreate.js';
import {indexCatalogMod} from './modSearchIndex.js';
import {normalizeVersionLabel} from './modSlug.js';
import {
  BOT_MOD_DIFF,
  decideBotModGate,
  decideBotModReleaseAction,
  snapshotDescription,
  snapshotDownloadUrl,
  snapshotVersion,
} from './botModDiff.js';
import {
  botModIdFromName,
  groupFeedMods,
  type BotModFeedRelease,
  type BotModFeedRow,
  type GroupedBotModFeed,
} from './botModIdentity.js';

export const DEFAULT_BOT_MODS_URL = 'https://bot.adofai.gg/api/mods/';
const FETCH_TIMEOUT_MS = 30_000;
const NAME_MAX = 512;
const USERNAME_MAX = 64;
const DISCORD_ID_MAX = 32;
const MONGO_ID_MAX = 32;
const LIST_DEFAULT_LIMIT = 200;
const LIST_MAX_LIMIT = 500;

const sequelize = getSequelizeForModelGroup('admin');

export const BOT_MOD_LIST_FILTERS = ['all', 'unlinked', 'linked', 'problems', 'duplicates'] as const;
export type BotModListFilter = (typeof BOT_MOD_LIST_FILTERS)[number];

export type SerializedBotModLink = {
  modId: number;
  modName: string | null;
  modSlug: string | null;
  enabled: boolean;
  lastAppliedVersion: string | null;
  lastAppliedDownloadUrl: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncMessage: string | null;
};

export type SerializedBotMod = {
  id: string;
  name: string;
  version: string | null;
  parsedDownload: string | null;
  download: string | null;
  description: string | null;
  cachedUsername: string;
  creatorDiscordId: string;
  uploadedAt: string | null;
  ignoreUpdate: boolean;
  hideFromSearch: boolean;
  isDuplicate: boolean;
  lastSeenAt: string | null;
  missingSince: string | null;
  releases: Array<{version: string; uploadedAt: string | null}>;
  link: SerializedBotModLink | null;
};

export type BotModsSyncResult = {
  fetched: number;
  upserted: number;
  missing: number;
  created: number;
  skipped: number;
  advanced: number;
  unchanged: number;
  ignored: number;
  errors: number;
  alreadyRunning: boolean;
};

type BotModsSyncCounts = Omit<BotModsSyncResult, 'alreadyRunning'>;

function clip(raw: unknown, max: number): string {
  return String(raw ?? '').trim().slice(0, max);
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseUploadedAt(raw: unknown): Date | null {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

function asBoolean(raw: unknown): boolean {
  return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

export function parseBotModId(raw: unknown): string | null {
  const id = String(raw ?? '').trim();
  if (!id || id.length > NAME_MAX) return null;
  return id;
}

export function parseBotModListFilter(raw: unknown): BotModListFilter {
  if (typeof raw === 'string' && (BOT_MOD_LIST_FILTERS as readonly string[]).includes(raw)) {
    return raw as BotModListFilter;
  }
  return 'all';
}

export function parseBotModListOffset(raw: unknown): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

export function parseBotModListLimit(raw: unknown): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return LIST_DEFAULT_LIMIT;
  return Math.min(LIST_MAX_LIMIT, Math.max(1, n));
}

export function parseCatalogModId(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function isUniqueConstraintError(error: unknown): boolean {
  const err = error as {name?: string; parent?: {errno?: number}; original?: {errno?: number}};
  if (err?.name === 'SequelizeUniqueConstraintError') return true;
  const errno = err?.parent?.errno ?? err?.original?.errno;
  return errno === 1062;
}

function clientError(message: string, status: number): Error & {status: number} {
  const error = new Error(message) as Error & {status: number};
  error.status = status;
  return error;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 500);
  return 'Unknown error';
}

export function serializeBotMod(row: BotMod): SerializedBotMod {
  const link = row.link ?? null;
  const mod = link?.mod ?? null;
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    parsedDownload: row.parsedDownload,
    download: row.download,
    description: row.description,
    cachedUsername: row.cachedUsername,
    creatorDiscordId: row.creatorDiscordId,
    uploadedAt: iso(row.uploadedAt),
    ignoreUpdate: Boolean(row.ignoreUpdate),
    hideFromSearch: Boolean(row.hideFromSearch),
    isDuplicate: Boolean(row.isDuplicate),
    lastSeenAt: iso(row.lastSeenAt),
    missingSince: iso(row.missingSince),
    releases: [...(row.releases ?? [])]
      .sort((a, b) => {
        const left = a.uploadedAt instanceof Date ? a.uploadedAt.getTime() : 0;
        const right = b.uploadedAt instanceof Date ? b.uploadedAt.getTime() : 0;
        if (left !== right) return right - left;
        return b.version.localeCompare(a.version);
      })
      .map((release) => ({
        version: release.version,
        uploadedAt: iso(release.uploadedAt),
      })),
    link: link
      ? {
          modId: link.modId,
          modName: mod?.name ?? null,
          modSlug: mod?.slug ?? null,
          enabled: Boolean(link.enabled),
          lastAppliedVersion: link.lastAppliedVersion,
          lastAppliedDownloadUrl: link.lastAppliedDownloadUrl,
          lastSyncAt: iso(link.lastSyncAt),
          lastSyncStatus: link.lastSyncStatus,
          lastSyncMessage: link.lastSyncMessage,
        }
      : null,
  };
}

function isProblemRow(row: SerializedBotMod): boolean {
  if (row.isDuplicate) return false;
  if (row.missingSince) return true;
  if (row.ignoreUpdate) return true;
  const hasVersion =
    Boolean(snapshotVersion(row.version)) || row.releases.some((release) => snapshotVersion(release.version));
  if (!hasVersion) return true;
  if (row.link?.lastSyncStatus === 'error') return true;
  return false;
}

function parseFeedItem(raw: unknown, seenAt: Date): BotModFeedRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const name = clip(src.name, NAME_MAX);
  if (!name) return null;
  const parsedDownload = snapshotDownloadUrl(src.parsedDownload) || snapshotDownloadUrl(src.download) || null;
  const download = snapshotDownloadUrl(src.download) || null;
  return {
    id: botModIdFromName(name),
    sourceMongoId: clip(src._id, MONGO_ID_MAX) || null,
    name,
    version: snapshotVersion(src.version) || null,
    parsedDownload,
    download,
    description:
      typeof src.description === 'string'
        ? src.description
        : src.description === null || src.description === undefined
          ? null
          : String(src.description),
    cachedUsername: clip(src.cachedUsername, USERNAME_MAX) || 'unknown',
    creatorDiscordId: clip(src.user, DISCORD_ID_MAX),
    uploadedAt: parseUploadedAt(src.uploadedTimestamp),
    ignoreUpdate: asBoolean(src.ignoreUpdate),
    hideFromSearch: asBoolean(src.hideFromSearch),
    lastSeenAt: seenAt,
    missingSince: null,
    updatedAt: seenAt,
  };
}

export function botModsFeedUrl(): string {
  const raw = process.env.BOT_MODS_URL?.trim();
  return raw || DEFAULT_BOT_MODS_URL;
}

async function fetchBotModsFeed(url: string): Promise<unknown[]> {
  const response = await axios.get(url, {
    timeout: FETCH_TIMEOUT_MS,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'TUF-Website/bot-mods-sync',
    },
    validateStatus: (status) => status >= 200 && status < 300,
  });
  if (!Array.isArray(response.data)) {
    throw new Error('Bot mods feed was not a JSON array');
  }
  return response.data;
}

async function stampLink(
  link: BotModLink,
  patch: {
    status: string;
    message: string | null;
    at: Date;
    version?: string | null;
    url?: string | null;
    keepCursor?: boolean;
  },
): Promise<void> {
  const next: Partial<{
    lastSyncAt: Date;
    lastSyncStatus: string;
    lastSyncMessage: string | null;
    lastAppliedVersion: string | null;
    lastAppliedDownloadUrl: string | null;
  }> = {
    lastSyncAt: patch.at,
    lastSyncStatus: patch.status,
    lastSyncMessage: patch.message,
  };
  if (!patch.keepCursor) {
    if (patch.version !== undefined) next.lastAppliedVersion = patch.version || null;
    if (patch.url !== undefined) next.lastAppliedDownloadUrl = patch.url || null;
  }
  await link.update(next);
}

async function syncCatalogDescriptionFromBot(
  modId: number,
  version: string,
  description: string | null,
  notesMode: 'always' | 'if-empty',
): Promise<boolean> {
  if (!description) return false;
  let changed = false;
  const versionRow = await ModVersion.findOne({
    where: {modId, version: normalizeVersionLabel(version)},
  });
  const existingNotes = String(versionRow?.notes ?? '').trim();
  const shouldWriteNotes = notesMode === 'always' || !existingNotes;
  if (!shouldWriteNotes) return false;
  if (versionRow && (versionRow.notes || '') !== description) {
    await versionRow.update({notes: description});
    changed = true;
  }
  const mod = await Mod.findByPk(modId);
  if (mod && (mod.description || '') !== description) {
    await mod.update({description});
    changed = true;
  }
  return changed;
}

function releaseUploadedTime(value: Date | null | undefined): number {
  if (!(value instanceof Date)) return Number.NEGATIVE_INFINITY;
  const time = value.getTime();
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

function releasesForBot(bot: BotMod): BotModFeedRelease[] {
  const stored = Array.isArray(bot.releases) ? bot.releases : [];
  if (stored.length > 0) {
    return stored
      .map((release) => ({
        botId: bot.id,
        version: snapshotVersion(release.version),
        parsedDownload: snapshotDownloadUrl(release.parsedDownload),
        download: snapshotDownloadUrl(release.download) || null,
        description: snapshotDescription(release.description),
        uploadedAt: release.uploadedAt,
      }))
      .filter((release) => release.version && release.parsedDownload)
      .sort((a, b) => {
        const delta = releaseUploadedTime(a.uploadedAt) - releaseUploadedTime(b.uploadedAt);
        if (delta !== 0) return delta;
        return a.version.localeCompare(b.version);
      });
  }

  const version = snapshotVersion(bot.version);
  const parsedDownload = snapshotDownloadUrl(bot.parsedDownload);
  if (!version || !parsedDownload) return [];
  return [
    {
      botId: bot.id,
      version,
      parsedDownload,
      download: snapshotDownloadUrl(bot.download) || null,
      description: snapshotDescription(bot.description),
      uploadedAt: bot.uploadedAt,
    },
  ];
}

async function applyLinkedSnapshot(link: BotModLink, seenAt: Date, counts: BotModsSyncCounts, createdModIds: Set<number>): Promise<void> {
  const bot = link.botMod;
  if (!bot) {
    counts.errors += 1;
    await stampLink(link, {
      status: 'error',
      message: 'Bot snapshot missing',
      at: seenAt,
      keepCursor: true,
    });
    return;
  }

  const gate = decideBotModGate({
    enabled: Boolean(link.enabled),
    ignoreUpdate: Boolean(bot.ignoreUpdate),
    isDuplicate: Boolean(bot.isDuplicate),
    missing: Boolean(bot.missingSince),
  });
  if (gate === BOT_MOD_DIFF.DISABLED) return;
  if (gate === BOT_MOD_DIFF.DUPLICATE) {
    counts.ignored += 1;
    await stampLink(link, {
      status: 'duplicate',
      message: 'Marked as duplicate',
      at: seenAt,
      keepCursor: true,
    });
    return;
  }
  if (gate === BOT_MOD_DIFF.IGNORE_UPDATE) {
    counts.ignored += 1;
    await stampLink(link, {
      status: 'ignored',
      message: 'Bot marked ignoreUpdate',
      at: seenAt,
      keepCursor: true,
    });
    return;
  }
  if (gate === BOT_MOD_DIFF.MISSING) {
    await stampLink(link, {
      status: 'missing',
      message: 'Not present in the latest feed',
      at: seenAt,
      keepCursor: true,
    });
    return;
  }

  const releases = releasesForBot(bot);
  const catalogRows = await ModVersion.findAll({
    where: {modId: link.modId},
    attributes: ['version'],
  });
  const catalogVersions = new Set(catalogRows.map((row) => normalizeVersionLabel(row.version)));

  let cursorVersion = snapshotVersion(link.lastAppliedVersion);
  let cursorUrl = snapshotDownloadUrl(link.lastAppliedDownloadUrl);
  let cursorTouched = false;
  const createdVersions: string[] = [];
  const skippedVersions: string[] = [];
  const advancedVersions: string[] = [];
  const errors: string[] = [];

  const rememberCursor = (version: string, downloadUrl: string) => {
    cursorVersion = version;
    cursorUrl = downloadUrl;
    cursorTouched = true;
  };

  if (releases.length === 0) {
    const action = decideBotModReleaseAction({
      version: bot.version,
      parsedDownload: bot.parsedDownload,
      lastAppliedVersion: cursorVersion,
      lastAppliedDownloadUrl: cursorUrl,
      catalogHasVersion: false,
    });
    counts.errors += 1;
    await stampLink(link, {
      status: 'error',
      message: action.kind === BOT_MOD_DIFF.MISSING_DOWNLOAD ? 'Missing download URL' : 'Empty version',
      at: seenAt,
      keepCursor: true,
    });
    return;
  }

  for (const release of releases) {
    const version = release.version;
    const downloadUrl = release.parsedDownload;
    const description = release.description;
    const catalogKey = normalizeVersionLabel(version);
    const action = decideBotModReleaseAction({
      version,
      parsedDownload: downloadUrl,
      lastAppliedVersion: cursorVersion,
      lastAppliedDownloadUrl: cursorUrl,
      catalogHasVersion: catalogVersions.has(catalogKey),
    });

    if (action.kind === BOT_MOD_DIFF.NOOP) {
      counts.unchanged += 1;
      if (await syncCatalogDescriptionFromBot(link.modId, version, description, 'if-empty')) {
        createdModIds.add(link.modId);
      }
      rememberCursor(version, downloadUrl);
      continue;
    }
    if (action.kind === BOT_MOD_DIFF.ADVANCE_URL) {
      counts.advanced += 1;
      advancedVersions.push(version);
      if (await syncCatalogDescriptionFromBot(link.modId, version, description, 'if-empty')) {
        createdModIds.add(link.modId);
      }
      rememberCursor(version, downloadUrl);
      continue;
    }
    if (action.kind === BOT_MOD_DIFF.SKIP_EXISTING) {
      counts.skipped += 1;
      skippedVersions.push(version);
      if (await syncCatalogDescriptionFromBot(link.modId, version, description, 'if-empty')) {
        createdModIds.add(link.modId);
      }
      rememberCursor(version, downloadUrl);
      continue;
    }
    if (action.kind === BOT_MOD_DIFF.EMPTY_VERSION) {
      counts.errors += 1;
      errors.push('Empty version');
      continue;
    }
    if (action.kind === BOT_MOD_DIFF.MISSING_DOWNLOAD) {
      counts.errors += 1;
      errors.push(`${version}: missing download URL`);
      continue;
    }
    if (action.kind !== BOT_MOD_DIFF.CREATE_RELEASE) continue;

    try {
      await createModVersion({
        modId: link.modId,
        version,
        downloadUrl,
        notes: description,
        releasedAt: release.uploadedAt || seenAt,
      });
      catalogVersions.add(catalogKey);
      if (await syncCatalogDescriptionFromBot(link.modId, version, description, 'always')) {
        createdModIds.add(link.modId);
      }
      createdModIds.add(link.modId);
      counts.created += 1;
      createdVersions.push(version);
      rememberCursor(version, downloadUrl);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        catalogVersions.add(catalogKey);
        counts.skipped += 1;
        skippedVersions.push(version);
        if (await syncCatalogDescriptionFromBot(link.modId, version, description, 'if-empty')) {
          createdModIds.add(link.modId);
        }
        rememberCursor(version, downloadUrl);
        continue;
      }
      counts.errors += 1;
      errors.push(`${version}: ${errorMessage(error)}`);
      logger.error('Bot mod auto-release failed', {botId: bot.id, name: bot.name, modId: link.modId, error});
    }
  }

  const messageParts = [
    createdVersions.length ? `Created release ${createdVersions.join(', ')}` : '',
    errors.join('; '),
  ].filter(Boolean);
  let status = 'ok';
  let message: string | null = null;
  if (errors.length) {
    status = 'error';
    message = messageParts.join('; ') || 'Release sync failed';
  } else if (createdVersions.length) {
    status = 'created';
    message = `Created release ${createdVersions.join(', ')}`;
  } else if (advancedVersions.length) {
    message = 'Download URL changed for the same version';
  } else if (skippedVersions.length) {
    status = 'skipped';
    message = `Version ${skippedVersions.join(', ')} already exists`;
  }

  await stampLink(link, {
    status,
    message,
    at: seenAt,
    keepCursor: !cursorTouched,
    version: cursorTouched ? cursorVersion : undefined,
    url: cursorTouched ? cursorUrl : undefined,
  });
}

async function reindexCreatedMods(createdModIds: Set<number>): Promise<void> {
  if (createdModIds.size === 0) return;
  for (const modId of createdModIds) {
    try {
      await indexCatalogMod(modId);
    } catch (error) {
      logger.error('Bot mod search reindex failed', {modId, error});
    }
  }
  try {
    await invalidatePublicModsCache();
  } catch (error) {
    logger.error('Bot mod cache invalidate failed', error);
  }
}

async function applyLinkNow(link: BotModLink): Promise<void> {
  const counts: BotModsSyncCounts = {
    fetched: 0,
    upserted: 0,
    missing: 0,
    created: 0,
    skipped: 0,
    advanced: 0,
    unchanged: 0,
    ignored: 0,
    errors: 0,
  };
  const createdModIds = new Set<number>();
  await applyLinkedSnapshot(link, new Date(), counts, createdModIds);
  await reindexCreatedMods(createdModIds);
}

function feedRow(group: GroupedBotModFeed): BotModFeedRow {
  return {
    id: group.id,
    sourceMongoId: group.sourceMongoId,
    name: group.name,
    version: group.version,
    parsedDownload: group.parsedDownload,
    download: group.download,
    description: group.description,
    cachedUsername: group.cachedUsername,
    creatorDiscordId: group.creatorDiscordId,
    uploadedAt: group.uploadedAt,
    ignoreUpdate: group.ignoreUpdate,
    hideFromSearch: group.hideFromSearch,
    lastSeenAt: group.lastSeenAt,
    missingSince: group.missingSince,
    updatedAt: group.updatedAt,
  };
}

async function replaceBotModReleases(groups: GroupedBotModFeed[]): Promise<void> {
  const rows = groups.flatMap((group) => group.releases);
  for (const group of groups) {
    const versions = group.releases.map((release) => release.version);
    await BotModRelease.destroy({
      where: versions.length
        ? {botId: group.id, version: {[Op.notIn]: versions}}
        : {botId: group.id},
    });
  }
  if (rows.length === 0) return;
  await BotModRelease.bulkCreate(rows, {
    updateOnDuplicate: ['parsedDownload', 'download', 'description', 'uploadedAt', 'updatedAt'],
  });
}

const botModDetailInclude = [
  {
    model: BotModLink,
    as: 'link' as const,
    include: [{model: Mod, as: 'mod' as const, attributes: ['id', 'name', 'slug'], required: false}],
  },
  {model: BotModRelease, as: 'releases' as const, required: false},
];

const linkedBotInclude = [
  {
    model: BotMod,
    as: 'botMod' as const,
    required: true,
    include: [{model: BotModRelease, as: 'releases' as const, required: false}],
  },
];

async function resolveBotMod(key: string): Promise<BotMod | null> {
  const byId = await BotMod.findByPk(key);
  if (byId) return byId;
  return BotMod.findOne({where: {name: clip(key, NAME_MAX)}});
}

async function runBotModsSyncOnce(): Promise<BotModsSyncResult> {
  const seenAt = new Date();
  const url = botModsFeedUrl();
  const feed = await fetchBotModsFeed(url);
  if (feed.length === 0) {
    throw new Error('Bot mods feed was empty');
  }

  const parsed: BotModFeedRow[] = [];
  for (const item of feed) {
    const row = parseFeedItem(item, seenAt);
    if (row) parsed.push(row);
  }
  const grouped = groupFeedMods(parsed);
  if (grouped.length === 0) {
    throw new Error('Bot mods feed had no usable rows');
  }
  const seenIds = grouped.map((row) => row.id);

  await BotMod.bulkCreate(grouped.map(feedRow), {
    updateOnDuplicate: [
      'sourceMongoId',
      'name',
      'version',
      'parsedDownload',
      'download',
      'description',
      'cachedUsername',
      'creatorDiscordId',
      'uploadedAt',
      'ignoreUpdate',
      'hideFromSearch',
      'lastSeenAt',
      'missingSince',
      'updatedAt',
    ],
  });

  await replaceBotModReleases(grouped);

  const [missingCount] = await BotMod.update(
    {missingSince: seenAt},
    {
      where: {
        id: {[Op.notIn]: seenIds},
        missingSince: {[Op.is]: null},
      },
    },
  );

  const counts: BotModsSyncCounts = {
    fetched: feed.length,
    upserted: grouped.length,
    missing: missingCount,
    created: 0,
    skipped: 0,
    advanced: 0,
    unchanged: 0,
    ignored: 0,
    errors: 0,
  };

  const links = await BotModLink.findAll({
    where: {enabled: true},
    include: [
      {
        model: BotMod,
        as: 'botMod',
        required: true,
        include: [{model: BotModRelease, as: 'releases', required: false}],
      },
    ],
  });
  const createdModIds = new Set<number>();
  for (const link of links) {
    await applyLinkedSnapshot(link, seenAt, counts, createdModIds);
  }

  await reindexCreatedMods(createdModIds);

  return {...counts, alreadyRunning: false};
}

let syncInFlight: Promise<BotModsSyncResult> | null = null;

export async function runBotModsSync(): Promise<BotModsSyncResult> {
  if (syncInFlight) {
    const result = await syncInFlight;
    return {...result, alreadyRunning: true};
  }
  const pending = runBotModsSyncOnce().finally(() => {
    if (syncInFlight === pending) syncInFlight = null;
  });
  syncInFlight = pending;
  return pending;
}

export async function listBotMods(options: {
  q?: string;
  filter: BotModListFilter;
  modId?: number;
  offset: number;
  limit: number;
}): Promise<{botMods: SerializedBotMod[]; total: number}> {
  const clauses: WhereOptions[] = [];
  if (typeof options.modId === 'number') {
    clauses.push({'$link.modId$': options.modId});
  }
  if (options.q) {
    const like = `%${escapeLike(options.q)}%`;
    clauses.push({
      [Op.or]: [
        {name: {[Op.like]: like}},
        {cachedUsername: {[Op.like]: like}},
        {id: {[Op.like]: like}},
        {creatorDiscordId: {[Op.like]: like}},
      ],
    });
  }
  const where: WhereOptions =
    clauses.length === 0 ? {} : clauses.length === 1 ? clauses[0] : {[Op.and]: clauses};

  const rows = await BotMod.findAll({
    where,
    include: [
      {
        model: BotModLink,
        as: 'link',
        required: Boolean(options.modId),
        include: [{model: Mod, as: 'mod', attributes: ['id', 'name', 'slug'], required: false}],
      },
      {model: BotModRelease, as: 'releases', required: false},
    ],
    order: [
      ['name', 'ASC'],
      ['id', 'ASC'],
    ],
  });

  let serialized = rows.map(serializeBotMod);
  if (options.filter === 'unlinked') {
    serialized = serialized.filter((row) => !row.link && !row.isDuplicate);
  } else if (options.filter === 'linked') {
    serialized = serialized.filter((row) => Boolean(row.link));
  } else if (options.filter === 'problems') {
    serialized = serialized.filter(isProblemRow);
  } else if (options.filter === 'duplicates') {
    serialized = serialized.filter((row) => row.isDuplicate);
  }

  const total = serialized.length;
  return {
    botMods: serialized.slice(options.offset, options.offset + options.limit),
    total,
  };
}

export async function linkBotModToCatalog(key: string, modId: number): Promise<SerializedBotMod> {
  const bot = await resolveBotMod(key);
  if (!bot) throw clientError('Unknown bot mod. Run a sync first.', 404);
  if (bot.isDuplicate) throw clientError('This scraped entry is marked as a duplicate', 400);
  const mod = await Mod.findByPk(modId);
  if (!mod) throw clientError('Mod not found', 404);
  const botId = bot.id;

  const transaction = await sequelize.transaction();
  try {
    await BotModLink.destroy({
      where: {[Op.or]: [{botId}, {modId}]},
      transaction,
    });
    await BotModLink.create(
      {
        botId,
        modId,
        enabled: true,
        lastAppliedVersion: null,
        lastAppliedDownloadUrl: null,
        lastSyncAt: new Date(),
        lastSyncStatus: 'linked',
        lastSyncMessage: null,
      },
      {transaction},
    );
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }

  const link = await BotModLink.findOne({
    where: {botId},
    include: linkedBotInclude,
  });
  if (link) {
    await applyLinkNow(link);
  }

  const reloaded = await BotMod.findByPk(botId, {include: botModDetailInclude});
  if (!reloaded) throw clientError('Unknown bot mod. Run a sync first.', 404);
  return serializeBotMod(reloaded);
}

export async function unlinkBotMod(key: string): Promise<void> {
  const bot = await resolveBotMod(key);
  if (!bot) throw clientError('Unknown bot mod', 404);
  const deleted = await BotModLink.destroy({where: {botId: bot.id}});
  if (deleted === 0) throw clientError('Bot mod is not linked', 404);
}

export async function setBotModLinkEnabled(key: string, enabled: boolean): Promise<SerializedBotMod> {
  const bot = await resolveBotMod(key);
  if (!bot) throw clientError('Unknown bot mod', 404);
  const link = await BotModLink.findOne({where: {botId: bot.id}});
  if (!link) throw clientError('Bot mod is not linked', 404);
  await link.update({enabled});
  return loadSerializedBotMod(bot.id);
}

async function loadSerializedBotMod(botId: string): Promise<SerializedBotMod> {
  const reloaded = await BotMod.findByPk(botId, {include: botModDetailInclude});
  if (!reloaded) throw clientError('Unknown bot mod', 404);
  return serializeBotMod(reloaded);
}

export async function setBotModDuplicate(key: string, isDuplicate: boolean): Promise<SerializedBotMod> {
  const bot = await resolveBotMod(key);
  if (!bot) throw clientError('Unknown bot mod', 404);
  await bot.update({isDuplicate});
  return loadSerializedBotMod(bot.id);
}
