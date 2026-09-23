import axios from 'axios';
import {Op, type WhereOptions} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import BotMod from '@/models/misc/BotMod.js';
import BotModLink from '@/models/misc/BotModLink.js';
import Mod from '@/models/misc/Mod.js';
import ModVersion from '@/models/misc/ModVersion.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {invalidatePublicModsCache} from './modCache.js';
import {createModVersion} from './modCreate.js';
import {indexCatalogMod} from './modSearchIndex.js';
import {normalizeVersionLabel} from './modSlug.js';
import {
  BOT_MOD_DIFF,
  decideBotModLinkAction,
  snapshotDownloadUrl,
  snapshotVersion,
} from './botModDiff.js';

export const DEFAULT_BOT_MODS_URL = 'https://bot.adofai.gg/api/mods/';
const FETCH_TIMEOUT_MS = 30_000;
const NAME_MAX = 512;
const USERNAME_MAX = 64;
const DISCORD_ID_MAX = 32;
const MONGO_ID_MAX = 32;
const BOT_ID_MAX = 64;
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
  if (!id || id.length > BOT_ID_MAX) return null;
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
  if (!snapshotVersion(row.version)) return true;
  if (row.link?.lastSyncStatus === 'error') return true;
  return false;
}

type ParsedFeedItem = {
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

function parseFeedItem(raw: unknown, seenAt: Date): ParsedFeedItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const id = parseBotModId(src.id);
  if (!id) return null;
  const parsedDownload = snapshotDownloadUrl(src.parsedDownload) || snapshotDownloadUrl(src.download) || null;
  const download = snapshotDownloadUrl(src.download) || null;
  return {
    id,
    sourceMongoId: clip(src._id, MONGO_ID_MAX) || null,
    name: clip(src.name, NAME_MAX) || id,
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

  const version = snapshotVersion(bot.version);
  const downloadUrl = snapshotDownloadUrl(bot.parsedDownload);
  let catalogHasVersion = false;
  if (version) {
    const existing = await ModVersion.findOne({
      where: {modId: link.modId, version: normalizeVersionLabel(version)},
    });
    catalogHasVersion = Boolean(existing);
  }

  const action = decideBotModLinkAction({
    enabled: Boolean(link.enabled),
    ignoreUpdate: Boolean(bot.ignoreUpdate),
    isDuplicate: Boolean(bot.isDuplicate),
    missing: Boolean(bot.missingSince),
    version: bot.version,
    parsedDownload: bot.parsedDownload,
    lastAppliedVersion: link.lastAppliedVersion,
    lastAppliedDownloadUrl: link.lastAppliedDownloadUrl,
    catalogHasVersion,
  });

  switch (action.kind) {
    case BOT_MOD_DIFF.NOOP:
      counts.unchanged += 1;
      await stampLink(link, {status: 'ok', message: null, at: seenAt, keepCursor: true});
      return;
    case BOT_MOD_DIFF.ADVANCE_URL:
      counts.advanced += 1;
      await stampLink(link, {
        status: 'ok',
        message: 'Download URL changed for the same version',
        at: seenAt,
        version,
        url: downloadUrl,
      });
      return;
    case BOT_MOD_DIFF.SKIP_EXISTING:
      counts.skipped += 1;
      await stampLink(link, {
        status: 'skipped',
        message: `Version ${version} already exists`,
        at: seenAt,
        version,
        url: downloadUrl,
      });
      return;
    case BOT_MOD_DIFF.EMPTY_VERSION:
      counts.errors += 1;
      await stampLink(link, {
        status: 'error',
        message: 'Empty version',
        at: seenAt,
        keepCursor: true,
      });
      return;
    case BOT_MOD_DIFF.MISSING_DOWNLOAD:
      counts.errors += 1;
      await stampLink(link, {
        status: 'error',
        message: 'Missing download URL',
        at: seenAt,
        keepCursor: true,
      });
      return;
    case BOT_MOD_DIFF.DUPLICATE:
      counts.ignored += 1;
      await stampLink(link, {
        status: 'duplicate',
        message: 'Marked as duplicate',
        at: seenAt,
        keepCursor: true,
      });
      return;
    case BOT_MOD_DIFF.IGNORE_UPDATE:
      counts.ignored += 1;
      await stampLink(link, {
        status: 'ignored',
        message: 'Bot marked ignoreUpdate',
        at: seenAt,
        keepCursor: true,
      });
      return;
    case BOT_MOD_DIFF.MISSING:
      await stampLink(link, {
        status: 'missing',
        message: 'Not present in the latest feed',
        at: seenAt,
        keepCursor: true,
      });
      return;
    case BOT_MOD_DIFF.DISABLED:
      return;
    case BOT_MOD_DIFF.CREATE_RELEASE: {
      try {
        await createModVersion({
          modId: link.modId,
          version,
          downloadUrl,
          notes: null,
          releasedAt: bot.uploadedAt || seenAt,
        });
        createdModIds.add(link.modId);
        counts.created += 1;
        await stampLink(link, {
          status: 'created',
          message: `Created release ${version}`,
          at: seenAt,
          version,
          url: downloadUrl,
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          counts.skipped += 1;
          await stampLink(link, {
            status: 'skipped',
            message: `Version ${version} already exists`,
            at: seenAt,
            version,
            url: downloadUrl,
          });
          return;
        }
        counts.errors += 1;
        logger.error('Bot mod auto-release failed', {botId: bot.id, modId: link.modId, error});
        await stampLink(link, {
          status: 'error',
          message: errorMessage(error),
          at: seenAt,
          keepCursor: true,
        });
      }
      return;
    }
    default:
      return;
  }
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

async function runBotModsSyncOnce(): Promise<BotModsSyncResult> {
  const seenAt = new Date();
  const url = botModsFeedUrl();
  const feed = await fetchBotModsFeed(url);
  if (feed.length === 0) {
    throw new Error('Bot mods feed was empty');
  }

  const parsed: ParsedFeedItem[] = [];
  const seenIds: string[] = [];
  const seen = new Set<string>();
  for (const item of feed) {
    const row = parseFeedItem(item, seenAt);
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    seenIds.push(row.id);
    parsed.push(row);
  }
  if (parsed.length === 0) {
    throw new Error('Bot mods feed had no usable rows');
  }

  await BotMod.bulkCreate(parsed, {
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
    upserted: parsed.length,
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
    include: [{model: BotMod, as: 'botMod', required: true}],
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

export async function linkBotModToCatalog(botId: string, modId: number): Promise<SerializedBotMod> {
  const bot = await BotMod.findByPk(botId);
  if (!bot) throw clientError('Unknown bot mod id. Run a sync first.', 404);
  if (bot.isDuplicate) throw clientError('This scraped entry is marked as a duplicate', 400);
  const mod = await Mod.findByPk(modId);
  if (!mod) throw clientError('Mod not found', 404);

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
    include: [{model: BotMod, as: 'botMod', required: true}],
  });
  if (link) {
    await applyLinkNow(link);
  }

  const reloaded = await BotMod.findByPk(botId, {
    include: [
      {
        model: BotModLink,
        as: 'link',
        include: [{model: Mod, as: 'mod', attributes: ['id', 'name', 'slug']}],
      },
    ],
  });
  if (!reloaded) throw clientError('Unknown bot mod id. Run a sync first.', 404);
  return serializeBotMod(reloaded);
}

export async function unlinkBotMod(botId: string): Promise<void> {
  const deleted = await BotModLink.destroy({where: {botId}});
  if (deleted === 0) throw clientError('Bot mod is not linked', 404);
}

export async function setBotModLinkEnabled(botId: string, enabled: boolean): Promise<SerializedBotMod> {
  const link = await BotModLink.findOne({where: {botId}});
  if (!link) throw clientError('Bot mod is not linked', 404);
  await link.update({enabled});
  const reloaded = await BotMod.findByPk(botId, {
    include: [
      {
        model: BotModLink,
        as: 'link',
        include: [{model: Mod, as: 'mod', attributes: ['id', 'name', 'slug']}],
      },
    ],
  });
  if (!reloaded) throw clientError('Unknown bot mod id', 404);
  return serializeBotMod(reloaded);
}

async function loadSerializedBotMod(botId: string): Promise<SerializedBotMod> {
  const reloaded = await BotMod.findByPk(botId, {
    include: [
      {
        model: BotModLink,
        as: 'link',
        include: [{model: Mod, as: 'mod', attributes: ['id', 'name', 'slug']}],
      },
    ],
  });
  if (!reloaded) throw clientError('Unknown bot mod id', 404);
  return serializeBotMod(reloaded);
}

export async function setBotModDuplicate(botId: string, isDuplicate: boolean): Promise<SerializedBotMod> {
  const bot = await BotMod.findByPk(botId);
  if (!bot) throw clientError('Unknown bot mod id', 404);
  await bot.update({isDuplicate});
  return loadSerializedBotMod(botId);
}
