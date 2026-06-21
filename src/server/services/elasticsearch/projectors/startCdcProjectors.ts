import { subscribeStream } from '@/server/services/eventBus/index.js';
import type { CdcOp } from '@/server/services/eventBus/types.js';
import { CDC_WATCHED_TABLES } from '@/externalServices/cdcService/constants.js';
import { logger } from '@/server/services/core/LoggerService.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import { CacheInvalidation } from '@/server/middleware/cache.js';
import { parseCdcFields, rowId } from './cdcRowParse.js';
import { getLevelIdsByArtistId, getLevelIdsByPlayerId, getLevelIdsBySongId, getPassIdsByLevelId } from './cdcFanout.js';
import { cdcPassProjectorDebounce } from './cdcPassProjectorDebounce.js';
import { cdcLevelCreditsProjectorDebounce } from './cdcLevelCreditsProjectorDebounce.js';
import { CDC_PASSES_STREAM_BLOCK_MS } from '@/server/services/elasticsearch/misc/constants.js';
import { invalidatePackLevelsCachesForLevelIds } from '@/server/services/packs/packDetailCacheService.js';
import Curation from '@/models/curations/Curation.js';
import LevelTagAssignment from '@/models/levels/LevelTagAssignment.js';
import User from '@/models/auth/User.js';

const CDC_PREFIX = 'cdc:';

const cdcProjectorStoppers: Array<() => Promise<void>> = [];

function cdcProjectorsDisabledByEnv(): boolean {
  return process.env.CDC_PROJECTORS_DISABLED === '1' || process.env.CDC_PROJECTORS_DISABLED === 'true';
}

/** Close all CDC Redis stream blocking readers (used during MySQL restore). */
export async function stopCdcProjectors(): Promise<void> {
  if (cdcProjectorStoppers.length === 0) {
    return;
  }
  logger.info('[cdc-projectors] Stopping CDC stream readers...');
  await Promise.all(cdcProjectorStoppers.map((stop) => stop()));
  cdcProjectorStoppers.length = 0;
  logger.info('[cdc-projectors] CDC stream readers stopped');
}

function tableEnabled(table: string): boolean {
  const raw = process.env.CDC_PROJECTOR_TABLES;
  if (!raw || raw.trim() === '' || raw.trim() === '*') return true;
  const allow = new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return allow.has(table);
}

async function invalidateLevel(levelId: number): Promise<void> {
  await CacheInvalidation.invalidateTags([`level:${levelId}`, 'levels:all']);
  await invalidatePackLevelsCachesForLevelIds([levelId]);
}

async function invalidateLevels(levelIds: number[]): Promise<void> {
  if (levelIds.length === 0) return;
  const tags = ['levels:all', ...levelIds.map((id) => `level:${id}`)];
  await CacheInvalidation.invalidateTags(tags);
  await invalidatePackLevelsCachesForLevelIds(levelIds);
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

/**
 * Level ES documents embed tag id/name/icon/color/group only (see levelIndexDocument).
 * `sortOrder` / `groupSortOrder` / timestamps affect admin UI ordering only — do not fan out to levels.
 * Inserts: no level references the tag until `level_tag_assignments` rows exist (handled there).
 */
function levelTagCdcChangeRequiresLevelReindex(
  op: CdcOp,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): boolean {
  if (op === 'd') return true;
  if (op === 'c') return false;
  if (op !== 'u' || !before || !after) return true;
  const norm = (v: unknown) => (v == null ? '' : String(v));
  const keys = ['name', 'icon', 'color', 'group'] as const;
  for (const k of keys) {
    if (norm(before[k]) !== norm(after[k])) return true;
  }
  return false;
}

/** Pass ES docs embed denormalized level fields (diffId, song, visibility, etc.). */
function levelCdcChangeRequiresPassReindex(
  op: CdcOp,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): boolean {
  if (op === 'd') return true;
  if (op === 'c') return false;
  if (op !== 'u' || !before || !after) return true;
  const norm = (v: unknown) => (v == null ? '' : String(v));
  const keys = [
    'diffId',
    'baseScore',
    'ppBaseScore',
    'song',
    'artist',
    'suffix',
    'songId',
    'dlLink',
    'isHidden',
    'isDeleted',
  ] as const;
  for (const k of keys) {
    if (norm(before[k]) !== norm(after[k])) return true;
  }
  return false;
}

export function startCdcProjectors(): void {
  if (cdcProjectorsDisabledByEnv()) {
    logger.info('[cdc-projectors] Disabled via CDC_PROJECTORS_DISABLED');
    return;
  }

  if (cdcProjectorStoppers.length > 0) {
    logger.warn('[cdc-projectors] Already running; duplicate start ignored');
    return;
  }

  const es = ElasticsearchService.getInstance();

  for (const table of CDC_WATCHED_TABLES) {
    if (!tableEnabled(table)) continue;

    const stream = `${CDC_PREFIX}${table}`;
    const isPassesStream = table === 'passes';
    const { stop } = subscribeStream({
      stream,
      consumerGroup: 'cdc-projectors',
      blockMs: isPassesStream ? CDC_PASSES_STREAM_BLOCK_MS : undefined,
      onIdle: isPassesStream
        ? () => cdcPassProjectorDebounce.flushOnStreamIdle()
        : undefined,
      partitionKey: (fields) => {
        const { before, after } = parseCdcFields(fields);
        const id = rowId(before, after);
        return id != null ? `${table}:${id}` : `${table}:unknown`;
      },
      handle: async (fields) => {
        const { op, before, after } = parseCdcFields(fields);

        switch (table) {
          case 'levels': {
            const id = rowId(before, after);
            if (id == null) return;
            await es.indexLevel(id);
            await invalidateLevel(id);
            if (levelCdcChangeRequiresPassReindex(op, before, after)) {
              const passIds = await getPassIdsByLevelId(id);
              if (passIds.length > 0) {
                await es.reindexPasses(passIds);
              }
            }
            break;
          }
          case 'passes': {
            const id = rowId(before, after);
            if (op === 'd') {
              const lid = num(before?.levelId);
              const playerId = num(before?.playerId);
              cdcPassProjectorDebounce.schedule({
                deletePassId: id,
                levelIds: lid != null ? [lid] : [],
                playerId,
              });
            } else {
              const prev = num(before?.levelId);
              const next = num(after?.levelId);
              const lids = new Set<number>();
              if (prev != null) lids.add(prev);
              if (next != null) lids.add(next);
              const playerId = num(after?.playerId ?? before?.playerId);
              cdcPassProjectorDebounce.schedule({
                passId: id,
                levelIds: lids,
                playerId,
              });
            }
            break;
          }
          case 'level_likes': {
            const lid = num(after?.levelId ?? before?.levelId);
            if (lid != null) {
              await es.indexLevel(lid);
              await invalidateLevel(lid);
            }
            break;
          }
          case 'players': {
            const pid = rowId(before, after);
            if (pid == null) return;
            if (op === 'd') {
              await es.deletePlayerDocumentById(pid);
              return;
            }
            await es.indexPlayer(pid);
            if (op === 'u' && Boolean(before?.isBanned) !== Boolean(after?.isBanned)) {
              const levelIds = await getLevelIdsByPlayerId(pid);
              if (levelIds.length) await es.reindexLevels(levelIds);
            }
            break;
          }
          case 'player_aliases': {
            const pid = num(after?.playerId ?? before?.playerId);
            if (pid != null) await es.indexPlayer(pid);
            break;
          }
          case 'users': {
            const prevP = num(before?.playerId);
            const nextP = num(after?.playerId);
            const pids = new Set<number>();
            if (prevP != null) pids.add(prevP);
            if (nextP != null) pids.add(nextP);
            if (pids.size > 0) await es.reindexPlayers([...pids]);

            const prevC = num(before?.creatorId);
            const nextC = num(after?.creatorId);
            const cids = new Set<number>();
            if (prevC != null) cids.add(prevC);
            if (nextC != null) cids.add(nextC);
            if (cids.size > 0) await es.reindexCreators([...cids]);
            break;
          }
          case 'user_oauth_providers': {
            const provider = (after?.provider ?? before?.provider) as string | undefined;
            if (provider !== 'discord') return;
            const userId = (after?.userId ?? before?.userId) as string | undefined;
            if (!userId) return;
            const user = await User.findByPk(userId, { attributes: ['playerId'] });
            const pl = user?.playerId;
            if (typeof pl === 'number' && pl > 0) await es.reindexPlayers([pl]);
            break;
          }
          case 'ratings':
          case 'level_aliases': {
            const lid = num(after?.levelId ?? before?.levelId);
            if (lid != null) {
              await es.indexLevel(lid);
              await invalidateLevel(lid);
            }
            break;
          }
          case 'level_credits': {
            // Credit edits destroy + recreate every row → a burst of events for
            // one level. Coalesce into a single level reindex + bulk creator
            // reindex instead of reindexing per row.
            const lid = num(after?.levelId ?? before?.levelId);
            const cid = num(after?.creatorId ?? before?.creatorId);
            cdcLevelCreditsProjectorDebounce.schedule({ levelId: lid, creatorId: cid });
            break;
          }
          case 'curations': {
            const lid = num(after?.levelId ?? before?.levelId);
            if (lid != null) {
              await es.indexLevel(lid);
              await invalidateLevel(lid);
            }
            break;
          }
          case 'curation_curation_types': {
            const curationId = num(after?.curationId ?? before?.curationId);
            if (curationId == null) return;
            const c = await Curation.findByPk(curationId, { attributes: ['levelId'] });
            const lid = c?.levelId;
            if (typeof lid === 'number' && lid > 0) {
              await es.indexLevel(lid);
              await invalidateLevel(lid);
            }
            break;
          }
          case 'level_tag_assignments': {
            const lid = num(after?.levelId ?? before?.levelId);
            if (lid != null) {
              await es.reindexLevels([lid]);
              await invalidateLevel(lid);
            }
            break;
          }
          case 'level_tags': {
            if (!levelTagCdcChangeRequiresLevelReindex(op, before, after)) {
              break;
            }
            const tagId = rowId(before, after);
            if (tagId == null) return;
            const assigns = await LevelTagAssignment.findAll({
              where: { tagId },
              attributes: ['levelId'],
              raw: true,
            });
            const lids = [...new Set((assigns as { levelId: number }[]).map((a) => a.levelId))].filter(Boolean);
            if (lids.length) {
              await es.reindexLevels(lids);
              await invalidateLevels(lids);
            }
            break;
          }
          case 'songs': {
            const sid = rowId(before, after);
            if (sid == null) return;
            const lids = await getLevelIdsBySongId(sid);
            if (lids.length) {
              await es.reindexLevels(lids);
              await invalidateLevels(lids);
            }
            break;
          }
          case 'song_aliases':
          case 'song_credits': {
            const sid = num(after?.songId ?? before?.songId);
            if (sid == null) return;
            const lids = await getLevelIdsBySongId(sid);
            if (lids.length) {
              await es.reindexLevels(lids);
              await invalidateLevels(lids);
            }
            break;
          }
          case 'artists': {
            const aid = rowId(before, after);
            if (aid == null) return;
            const lids = await getLevelIdsByArtistId(aid);
            if (lids.length) {
              es.scheduleDebouncedArtistReindex(lids);
              await invalidateLevels(lids);
            }
            break;
          }
          case 'artist_aliases': {
            const aid = num(after?.artistId ?? before?.artistId);
            if (aid == null) return;
            const lids = await getLevelIdsByArtistId(aid);
            if (lids.length) {
              es.scheduleDebouncedArtistReindex(lids);
              await invalidateLevels(lids);
            }
            break;
          }
          case 'creators': {
            const cid = rowId(before, after);
            if (cid == null) return;
            if (op === 'd') {
              await es.deleteCreatorDocumentById(cid);
              return;
            }
            await es.indexCreator(cid);
            // Level index embeds credited creator display names; refresh when it changes.
            if (op === 'u') {
              const beforeName = before?.name != null ? String(before.name) : null;
              const afterName = after?.name != null ? String(after.name) : null;
              if (beforeName !== afterName) {
                void es.reindexByCreatorId(cid);
              }
            }
            break;
          }
          case 'creator_aliases': {
            const cid = num(after?.creatorId ?? before?.creatorId);
            if (cid != null) await es.indexCreator(cid);
            break;
          }
          default:
            break;
        }
      },
    });
    cdcProjectorStoppers.push(stop);
  }
  logger.info(`[cdc-projectors] Subscribed ${cdcProjectorStoppers.length} CDC streams`);
}
