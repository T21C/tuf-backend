import mysql, { type Connection } from 'mysql2/promise';
import { QueryTypes } from 'sequelize';
import { getSequelizeForModelGroup } from '@/config/db.js';
import { isShuttingDown } from '@/server/bootstrap/shutdownCoordinator.js';
import { logger } from '@/server/services/core/LoggerService.js';
import {
  BadgeJobCancelled,
  isBadgeCancelRequested,
  setBadgeWatchErrorHandler,
  stopBadgeWatch,
  throwIfBadgeCancelled,
  watchBadgeJob,
} from './cancelSignal.js';
import { evaluateBadge, type OwnerInput } from '../engine/evaluate.js';
import {
  catalogDifficultyCoverage,
  identityModesForDifficultyBadges,
  prepareOwnerDifficultyCounts,
} from '../engine/difficultyCoverage.js';
import { applyGrant, type StoredBadge } from '../engine/grant.js';
import { loadBadgeCatalog, type BadgeCatalog } from '../catalog/load.js';
import {
  defMatchesSlice,
  needsGlobalWorld,
  needsWorld,
  packDefMatches,
} from '../engine/interest.js';
import { computeRollups, planValueSource, unionDemands } from '../engine/planExpr.js';
import type { BadgeDraft } from '../engine/params.js';
import { definitionFromRow, type DefinitionRow } from './definitions.js';
import { parseDirt, type BadgeDirt } from './dirt.js';
import { compareOwners, inOwnerRange, ownerRangeFrom, parseOwnerKind } from './owners.js';

type JobRow = {
  id: number;
  scope: string;
  definitionId: number | null;
  playerId: number | null;
  creatorId: number | null;
  levelId: number | null;
  packId: number | null;
  replaceState: number;
  startFrom: number;
  ownerFrom?: number | null;
  ownerTo?: number | null;
  ownerKind?: string | null;
  processed: number;
  dirt?: unknown;
};

type OwnerWork = {
  audience: 'player' | 'creator';
  id: number;
  defs: BadgeDraft[];
};

function badgeDb() {
  return getSequelizeForModelGroup('badges');
}

async function select<T>(sql: string, replacements?: Record<string, unknown>): Promise<T[]> {
  return badgeDb().query(sql, { replacements, type: QueryTypes.SELECT }) as Promise<T[]>;
}

async function loadDefinitions(job: JobRow): Promise<BadgeDraft[]> {
  const sql = job.definitionId
    ? 'SELECT * FROM badge_definitions WHERE id = :id'
    : 'SELECT * FROM badge_definitions WHERE enabled = 1';
  const rows = await select<DefinitionRow>(sql, { id: job.definitionId });
  const defs = rows.map(definitionFromRow).filter((row): row is BadgeDraft => row != null && row.enabled);
  const kind = parseOwnerKind(job.ownerKind);
  const scoped = kind ? defs.filter((def) => def.audience === kind) : defs;
  if (job.scope === 'pack') {
    return scoped.filter((def) => packDefMatches(def, job.packId == null ? null : Number(job.packId)));
  }
  return scoped;
}

async function playerIdsForLevel(levelId: number): Promise<number[]> {
  return playerIdsForLevels([levelId]);
}

async function playerIdsForLevels(levelIds: number[]): Promise<number[]> {
  const ids = [...new Set(levelIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return [];
  const rows = await select<{ playerId: number }>(
    `SELECT DISTINCT playerId FROM passes
     WHERE levelId IN (:ids) AND IFNULL(isDeleted, 0) = 0 AND IFNULL(isHidden, 0) = 0`,
    { ids },
  );
  return rows.map((row) => Number(row.playerId));
}

function stateKey(ownerType: string, ownerId: number, definitionId: number): string {
  return `${ownerType}:${ownerId}:${definitionId}`;
}

function asIdList(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number).filter((id) => Number.isInteger(id));
  if (typeof value === 'string') {
    try {
      return asIdList(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return [];
}

function asSnapshot(value: unknown): number[] | null {
  if (value == null || value === 'null') return null;
  if (typeof value === 'string') {
    try {
      return asSnapshot(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!Array.isArray(value)) return null;
  return asIdList(value);
}

function sameNum(left: number, right: number): boolean {
  return left === right || Math.abs(left - right) < 1e-9;
}

function sameIdList(left: number[] | null, right: number[] | null): boolean {
  if (left == null && right == null) return true;
  if (left == null || right == null || left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}

function sameState(previous: StoredBadge | null, next: StoredBadge): boolean {
  if (!previous) return false;
  return previous.tier === next.tier
    && sameNum(previous.credit, next.credit)
    && sameNum(previous.barFrom, next.barFrom)
    && sameNum(previous.barTo, next.barTo)
    && sameNum(previous.barValue, next.barValue)
    && previous.earnedAt === next.earnedAt
    && previous.tierLabel === next.tierLabel
    && sameIdList(previous.provingPassIds, next.provingPassIds)
    && sameIdList(previous.snapshotIds, next.snapshotIds);
}

function rowToState(row: {
  tier: number;
  credit: number;
  barFrom: number;
  barTo: number;
  barValue: number;
  provingPassIds: unknown;
  earnedAt: Date | null;
  tierLabel?: string | null;
  snapshotIds: unknown;
}): StoredBadge {
  return {
    tier: Number(row.tier) || 0,
    credit: Number(row.credit) || 0,
    barFrom: Number(row.barFrom) || 0,
    barTo: Number(row.barTo) || 0,
    barValue: Number(row.barValue) || 0,
    provingPassIds: asIdList(row.provingPassIds),
    earnedAt: row.earnedAt ? new Date(row.earnedAt).toISOString() : null,
    tierLabel: row.tierLabel ?? null,
    snapshotIds: asSnapshot(row.snapshotIds),
  };
}

async function loadStates(definitionIds: number[]): Promise<Map<string, StoredBadge>> {
  const states = new Map<string, StoredBadge>();
  if (!definitionIds.length) return states;
  const rows = await select<{
    ownerType: string;
    ownerId: number;
    definitionId: number;
    tier: number;
    credit: number;
    barFrom: number;
    barTo: number;
    barValue: number;
    provingPassIds: unknown;
    earnedAt: Date | null;
    tierLabel: string | null;
    snapshotIds: unknown;
  }>(
    `SELECT ownerType, ownerId, definitionId, tier, credit, barFrom, barTo, barValue, provingPassIds, earnedAt, tierLabel, snapshotIds
     FROM badge_states
     WHERE definitionId IN (:ids)`,
    { ids: definitionIds },
  );
  for (const row of rows) {
    states.set(stateKey(row.ownerType, Number(row.ownerId), Number(row.definitionId)), rowToState(row));
  }
  return states;
}

type EtaSample = { t: number; p: number };

const ETA_FULL_MS = 5 * 60 * 1000;
const ETA_HORIZON_MS = 30 * 60 * 1000;

function readEtaSamples(value: unknown): EtaSample[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((sample) => {
    if (!sample || typeof sample !== 'object') return [];
    const time = Number((sample as { t?: unknown }).t);
    const position = Number((sample as { p?: unknown }).p);
    if (!Number.isFinite(time) || !Number.isFinite(position)) return [];
    return [{ t: time, p: position }];
  });
}

function rollingEtaMs(samples: EtaSample[], position: number, total: number, now: number): number | null {
  let weightedGain = 0;
  let weightedTime = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const next = samples[index];
    const elapsed = next.t - previous.t;
    const gained = next.p - previous.p;
    if (elapsed <= 0 || gained <= 0) continue;
    const age = now - ((previous.t + next.t) / 2);
    let weight = 1;
    if (age >= ETA_HORIZON_MS) weight = 0;
    else if (age > ETA_FULL_MS) weight = (ETA_HORIZON_MS - age) / (ETA_HORIZON_MS - ETA_FULL_MS);
    if (weight <= 0) continue;
    weightedGain += gained * weight;
    weightedTime += elapsed * weight;
  }
  if (weightedGain <= 0 || weightedTime < 4000) return null;
  return ((total - position) / weightedGain) * weightedTime;
}

async function loadEtaSamples(jobId: number): Promise<EtaSample[]> {
  const rows = await select<{ etaSamples: unknown }>(
    'SELECT etaSamples FROM badge_jobs WHERE id = :id',
    { id: jobId },
  );
  return readEtaSamples(rows[0]?.etaSamples);
}

const OWNER_NAME_MAX = 80;

function clipOwnerName(name: string | null | undefined): string | null {
  if (name == null) return null;
  const clipped = String(name).trim().slice(0, OWNER_NAME_MAX);
  return clipped || null;
}

async function writeJobProgress(jobId: number, progress: {
  processed: number;
  total: number;
  playerTotal: number;
  creatorTotal: number;
  playersProcessed: number;
  creatorsProcessed: number;
  phase: string;
  badgeCursor: number;
  badgeTotal: number;
  currentDefinitionId: number | null;
  currentOwnerId: number | null;
  currentOwnerName: string | null;
  etaMs: number | null;
  etaSamples: EtaSample[];
  definitionProgress: Record<string, number>;
}): Promise<void> {
  await badgeDb().query(
    `UPDATE badge_jobs
     SET processed = :processed, total = :total,
         playerTotal = :playerTotal, creatorTotal = :creatorTotal,
         playersProcessed = :playersProcessed, creatorsProcessed = :creatorsProcessed,
         phase = :phase, badgeCursor = :badgeCursor, badgeTotal = :badgeTotal,
         currentDefinitionId = :currentDefinitionId, currentOwnerId = :currentOwnerId,
         currentOwnerName = :currentOwnerName,
         etaMs = :etaMs,
         etaSamples = CAST(:etaSamples AS JSON),
         heartbeatAt = NOW(),
         definitionProgress = CAST(:definitionProgress AS JSON)
     WHERE id = :id AND status = 'running'`,
    {
      replacements: {
        id: jobId,
        processed: progress.processed,
        total: progress.total,
        playerTotal: progress.playerTotal,
        creatorTotal: progress.creatorTotal,
        playersProcessed: progress.playersProcessed,
        creatorsProcessed: progress.creatorsProcessed,
        phase: progress.phase,
        badgeCursor: progress.badgeCursor,
        badgeTotal: progress.badgeTotal,
        currentDefinitionId: progress.currentDefinitionId,
        currentOwnerId: progress.currentOwnerId,
        currentOwnerName: clipOwnerName(progress.currentOwnerName),
        etaMs: progress.etaMs,
        etaSamples: JSON.stringify(progress.etaSamples),
        definitionProgress: JSON.stringify(progress.definitionProgress),
      },
    },
  );
}

async function isCancelled(jobId: number): Promise<boolean> {
  const rows = await select<{ status: string }>(
    'SELECT status FROM badge_jobs WHERE id = :id',
    { id: jobId },
  );
  return rows[0]?.status === 'cancelled';
}

async function stopIfCancelled(jobId: number): Promise<void> {
  throwIfBadgeCancelled();
  if (await isCancelled(jobId)) throw new BadgeJobCancelled();
}

function affectedCount(result: unknown): number {
  if (typeof result === 'number') return result;
  if (Array.isArray(result)) {
    for (let index = result.length - 1; index >= 0; index -= 1) {
      const part = result[index];
      if (typeof part === 'number') return part;
      if (part && typeof part === 'object' && 'affectedRows' in part) {
        return Number((part as { affectedRows: number }).affectedRows) || 0;
      }
    }
  }
  if (result && typeof result === 'object' && 'affectedRows' in result) {
    return Number((result as { affectedRows: number }).affectedRows) || 0;
  }
  return 0;
}

const STATE_WRITE_BATCH = 50;
const REVIEW_WRITE_BATCH = 100;
const PROGRESS_INTERVAL_MS = 1000;

type PendingStateWrite = {
  ownerType: string;
  ownerId: number;
  definitionId: number;
  state: StoredBadge;
};

async function flushStateWrites(pending: PendingStateWrite[]): Promise<void> {
  while (pending.length) {
    const batch = pending.splice(0, STATE_WRITE_BATCH);
    const replacements: Record<string, unknown> = {};
    const values = batch.map((row, index) => {
      replacements[`ot${index}`] = row.ownerType;
      replacements[`oid${index}`] = row.ownerId;
      replacements[`did${index}`] = row.definitionId;
      replacements[`tier${index}`] = row.state.tier;
      replacements[`credit${index}`] = row.state.credit;
      replacements[`from${index}`] = row.state.barFrom;
      replacements[`to${index}`] = row.state.barTo;
      replacements[`val${index}`] = row.state.barValue;
      replacements[`prov${index}`] = JSON.stringify(row.state.provingPassIds);
      replacements[`earn${index}`] = row.state.earnedAt ? new Date(row.state.earnedAt) : null;
      replacements[`lab${index}`] = row.state.tierLabel;
      replacements[`snap${index}`] = row.state.snapshotIds ? JSON.stringify(row.state.snapshotIds) : 'null';
      return `(:ot${index}, :oid${index}, :did${index}, :tier${index}, :credit${index}, :from${index}, :to${index}, :val${index}, CAST(:prov${index} AS JSON), :earn${index}, :lab${index}, CAST(:snap${index} AS JSON), NOW(), NOW())`;
    }).join(', ');
    await badgeDb().query(
      `INSERT INTO badge_states
        (ownerType, ownerId, definitionId, tier, credit, barFrom, barTo, barValue, provingPassIds, earnedAt, tierLabel, snapshotIds, createdAt, updatedAt)
       VALUES ${values}
       ON DUPLICATE KEY UPDATE
        tier = VALUES(tier), credit = VALUES(credit), barFrom = VALUES(barFrom), barTo = VALUES(barTo),
        barValue = VALUES(barValue), provingPassIds = VALUES(provingPassIds), earnedAt = VALUES(earnedAt),
        tierLabel = VALUES(tierLabel), snapshotIds = VALUES(snapshotIds), updatedAt = NOW()`,
      { replacements },
    );
  }
}

async function flushReviewWrites(pending: { definitionId: number; passId: number }[]): Promise<void> {
  while (pending.length) {
    const batch = pending.splice(0, REVIEW_WRITE_BATCH);
    const replacements: Record<string, unknown> = {};
    const values = batch.map((row, index) => {
      replacements[`d${index}`] = row.definitionId;
      replacements[`p${index}`] = row.passId;
      return `(:d${index}, :p${index}, '', 'pending', NOW(), NOW())`;
    }).join(', ');
    await badgeDb().query(
      `INSERT IGNORE INTO badge_reviews (definitionId, passId, videoUrl, status, createdAt, updatedAt)
       VALUES ${values}`,
      { replacements },
    );
  }
}

function jobOwnerRange(job: JobRow): { ownerFrom: number | null; ownerTo: number | null } {
  return ownerRangeFrom(job);
}

async function listedOwnerIds(
  table: 'players' | 'creators',
  from: number | null,
  to: number | null,
): Promise<number[]> {
  const where: string[] = [];
  const replacements: Record<string, unknown> = {};
  if (from != null) {
    where.push('id >= :from');
    replacements.from = from;
  }
  if (to != null) {
    where.push('id <= :to');
    replacements.to = to;
  }
  const rows = await select<{ id: number }>(
    `SELECT id FROM ${table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id ASC`,
    replacements,
  );
  return rows.map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0);
}

function sortOwners(owners: OwnerWork[]): OwnerWork[] {
  return [...owners].sort(compareOwners);
}

async function ownersFor(job: JobRow, defs: BadgeDraft[], catalog: BadgeCatalog): Promise<OwnerWork[]> {
  const withDefs = (audience: 'player' | 'creator', id: number): OwnerWork => ({
    audience,
    id,
    defs: defs.filter((def) => def.audience === audience),
  });
  const range = jobOwnerRange(job);
  const inRange = (id: number) => inOwnerRange(id, range.ownerFrom, range.ownerTo);
  const kind = parseOwnerKind(job.ownerKind);
  if (job.scope === 'player' && job.playerId) return [withDefs('player', Number(job.playerId))];
  if (job.scope === 'creator' && job.creatorId) return [withDefs('creator', Number(job.creatorId))];
  const out: OwnerWork[] = [];
  const wantPlayer = kind !== 'creator' && defs.some((def) => def.audience === 'player');
  const wantCreator = kind !== 'player' && defs.some((def) => def.audience === 'creator');
  if (job.scope === 'chart' && job.levelId) {
    if (wantPlayer) {
      const ids = new Set(catalog.passes.filter((pass) => pass.levelId === Number(job.levelId)).map((pass) => pass.playerId));
      for (const id of await playerIdsForLevel(Number(job.levelId))) ids.add(id);
      for (const id of [...ids].filter(inRange).sort((left, right) => left - right)) out.push(withDefs('player', id));
    }
    if (wantCreator) {
      const ids = new Set<number>();
      const chart = catalog.charts.find((item) => item.id === Number(job.levelId));
      for (const id of chart?.charterIds ?? []) ids.add(id);
      for (const id of chart?.vfxerIds ?? []) ids.add(id);
      if (job.creatorId) ids.add(Number(job.creatorId));
      for (const id of [...ids].filter(inRange).sort((left, right) => left - right)) out.push(withDefs('creator', id));
    }
    return out;
  }
  if (wantPlayer) {
    for (const id of await listedOwnerIds('players', range.ownerFrom, range.ownerTo)) {
      out.push(withDefs('player', id));
    }
  }
  if (wantCreator) {
    for (const id of await listedOwnerIds('creators', range.ownerFrom, range.ownerTo)) {
      out.push(withDefs('creator', id));
    }
  }
  return out;
}

function uniquePositive(ids: number[]): number[] {
  return [...new Set(ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

async function ownersForDirty(dirt: BadgeDirt, definitions: BadgeDraft[], catalog: BadgeCatalog): Promise<OwnerWork[]> {
  const hotPlayerDefs = definitions.filter((def) => defMatchesSlice(def, 'hotPlayer'));
  const hotCreatorDefs = definitions.filter((def) => defMatchesSlice(def, 'hotCreator'));
  const worldDefs = definitions.filter((def) => defMatchesSlice(def, 'chartWorld'));
  const catalogDefs = definitions.filter((def) => defMatchesSlice(def, 'catalog'));
  const packDefs = definitions.filter((def) => {
    if (!defMatchesSlice(def, 'pack')) return false;
    if (!dirt.packs.length) return true;
    return dirt.packs.some((packId) => packDefMatches(def, packId));
  });
  const owners: OwnerWork[] = [];
  for (const id of dirt.players) {
    const defs = hotPlayerDefs.filter((def) => def.audience === 'player');
    if (defs.length) owners.push({ audience: 'player', id, defs });
  }
  for (const id of dirt.creators) {
    if (hotCreatorDefs.length) owners.push({ audience: 'creator', id, defs: hotCreatorDefs });
  }
  if (dirt.levels.length && worldDefs.length) {
    const playerIds = new Set(await playerIdsForLevels(dirt.levels));
    for (const pass of catalog.passes) {
      if (dirt.levels.includes(pass.levelId)) playerIds.add(pass.playerId);
    }
    const playerWorldDefs = worldDefs.filter((def) => def.audience === 'player');
    for (const id of playerIds) {
      if (playerWorldDefs.length) owners.push({ audience: 'player', id, defs: playerWorldDefs });
    }
    const creatorWorldDefs = worldDefs.filter((def) => def.audience === 'creator');
    if (creatorWorldDefs.length) {
      const creatorIds = new Set<number>();
      for (const levelId of dirt.levels) {
        const chart = catalog.charts.find((item) => item.id === levelId);
        for (const id of chart?.charterIds ?? []) creatorIds.add(id);
        for (const id of chart?.vfxerIds ?? []) creatorIds.add(id);
      }
      for (const id of creatorIds) owners.push({ audience: 'creator', id, defs: creatorWorldDefs });
    }
  }
  if (dirt.packs.length && packDefs.length) {
    for (const owner of await ownersFor({ scope: 'all' } as JobRow, packDefs, catalog)) {
      if (owner.defs.length) owners.push(owner);
    }
  }
  if (dirt.catalog && catalogDefs.length) {
    for (const owner of await ownersFor({ scope: 'all' } as JobRow, catalogDefs, catalog)) {
      if (owner.defs.length) owners.push(owner);
    }
  }
  return sortOwners(owners.filter((owner) => owner.defs.length > 0));
}

async function ownerNames(): Promise<{ players: Map<number, string>; creators: Map<number, string> }> {
  const [players, creators] = await Promise.all([
    select<{ id: number; name: string }>('SELECT id, name FROM players'),
    select<{ id: number; name: string }>('SELECT id, name FROM creators'),
  ]);
  return {
    players: new Map(players.map((row) => [Number(row.id), row.name || ''])),
    creators: new Map(creators.map((row) => [Number(row.id), row.name || ''])),
  };
}

export async function runBadgeJob(job: JobRow): Promise<{ summary: string; skips: { placeholder: number; unknownTime: number; missingDifficulty: number }; cancelled?: boolean; timings?: { id: number; name: string; audience: string; runs: number; totalMs: number }[] }> {
  await stopIfCancelled(Number(job.id));
  const resumeAt = Math.max(0, Math.floor(Number(job.processed) || 0));
  const etaSamples = await loadEtaSamples(Number(job.id));
  let etaMs: number | null = null;
  await writeJobProgress(Number(job.id), {
    processed: resumeAt,
    total: 0,
    playerTotal: 0,
    creatorTotal: 0,
    playersProcessed: 0,
    creatorsProcessed: 0,
    phase: 'loading',
    badgeCursor: 0,
    badgeTotal: 0,
    currentDefinitionId: null,
    currentOwnerId: null,
    currentOwnerName: null,
    etaMs: null,
    etaSamples,
    definitionProgress: {},
  });
  await stopIfCancelled(Number(job.id));
  const loaded = await loadDefinitions(job);
  const dirt = job.scope === 'dirty' ? parseDirt(job.dirt) : null;
  const definitions = loaded;
  await stopIfCancelled(Number(job.id));
  const catalogNeedWorld = dirt
    ? dirt.levels.length > 0 && definitions.some(needsWorld)
    : definitions.some(needsWorld);
  const globalWorld = Boolean(dirt?.levels.length) && definitions.some(needsGlobalWorld);
  const needAllPlayers = Boolean(dirt && (dirt.catalog || dirt.packs.length > 0 || (catalogNeedWorld && globalWorld)));
  const warmPlayers = dirt?.levels.length ? await playerIdsForLevels(dirt.levels) : [];
  const scopedPlayerIds = uniquePositive([...(dirt?.players ?? []), ...warmPlayers]);
  const catalog = await loadBadgeCatalog({
    playerIds: dirt
      ? (needAllPlayers ? undefined : (scopedPlayerIds.length ? scopedPlayerIds : [0]))
      : (job.scope === 'player' && job.playerId ? [Number(job.playerId)] : undefined),
    needWorld: catalogNeedWorld,
    worldLevelIds: dirt && catalogNeedWorld && !globalWorld ? dirt.levels : undefined,
  });
  const playerDifficultyModes = identityModesForDifficultyBadges(
    definitions.filter((def) => def.audience === 'player'),
  );
  const creatorDifficultyModes = identityModesForDifficultyBadges(
    definitions.filter((def) => def.audience === 'creator'),
  );
  for (const mode of new Set([...playerDifficultyModes, ...creatorDifficultyModes])) {
    catalogDifficultyCoverage(catalog.charts, catalog.links, mode);
  }
  await stopIfCancelled(Number(job.id));
  const passesByPlayer = new Map<number, BadgeCatalog['passes']>();
  for (const pass of catalog.passes) {
    const list = passesByPlayer.get(pass.playerId);
    if (list) list.push(pass);
    else passesByPlayer.set(pass.playerId, [pass]);
  }
  const owners = dirt
    ? await ownersForDirty(dirt, definitions, catalog)
    : await ownersFor(job, definitions, catalog);
  const names = await ownerNames();
  const definitionIds = [...new Set(
    owners.flatMap((owner) => owner.defs.map((def) => def.id)).filter((id): id is number => Number.isInteger(id)),
  )];
  const states = job.replaceState ? new Map<string, StoredBadge>() : await loadStates(definitionIds);
  const reviewKeys = new Set(catalog.reviews.map((review) => `${review.definitionId}:${review.passId}`));
  const pendingStates: PendingStateWrite[] = [];
  const pendingReviews: { definitionId: number; passId: number }[] = [];
  const skips = { placeholder: 0, unknownTime: 0, missingDifficulty: 0 };
  let writes = 0;
  const skip = Math.min(resumeAt, owners.length);
  let processed = skip;
  let playersProcessed = 0;
  let creatorsProcessed = 0;
  for (let index = 0; index < skip; index += 1) {
    if (owners[index].audience === 'player') playersProcessed += 1;
    else creatorsProcessed += 1;
  }
  let badgeCursor = 0;
  let badgeTotal = 0;
  let currentDefinitionId: number | null = null;
  let currentOwnerId: number | null = null;
  let currentOwnerName: string | null = null;
  const definitionCounts = new Map<number, number>();
  const definitionTimings = new Map<number, { name: string; audience: string; runs: number; totalMs: number }>();
  for (const def of definitions) {
    if (!def.id) continue;
    const restored = def.audience === 'player' ? playersProcessed : creatorsProcessed;
    if (restored > 0) definitionCounts.set(def.id, restored);
  }
  const playerTotal = owners.filter((owner) => owner.audience === 'player').length;
  const creatorTotal = owners.filter((owner) => owner.audience === 'creator').length;
  const progressPayload = (phase: string) => {
    if (phase === 'running' && owners.length > 0 && badgeTotal > 0) {
      const position = processed + badgeCursor / badgeTotal;
      const now = Date.now();
      const last = etaSamples[etaSamples.length - 1];
      if (last && position + 0.5 < last.p) etaSamples.splice(0, etaSamples.length);
      const tail = etaSamples[etaSamples.length - 1];
      if (!tail || (position > tail.p + 1e-4 && now - tail.t >= 2000)) etaSamples.push({ t: now, p: position });
      const cutoff = now - ETA_HORIZON_MS;
      while (etaSamples.length > 2 && etaSamples[0].t < cutoff) etaSamples.shift();
      etaMs = rollingEtaMs(etaSamples, position, owners.length, now);
    }
    return {
      processed,
      total: owners.length,
      playerTotal,
      creatorTotal,
      playersProcessed,
      creatorsProcessed,
      phase,
      badgeCursor,
      badgeTotal,
      currentDefinitionId,
      currentOwnerId,
      currentOwnerName,
      etaMs,
      etaSamples,
      definitionProgress: Object.fromEntries(definitionCounts),
    };
  };
  await writeJobProgress(Number(job.id), progressPayload('running'));
  const now = new Date().toISOString();
  let lastProgressAt = Date.now();
  const writeProgress = async (force = false) => {
    const at = Date.now();
    if (!force && at - lastProgressAt < PROGRESS_INTERVAL_MS) return;
    lastProgressAt = at;
    await writeJobProgress(Number(job.id), progressPayload('running'));
  };
  const queueState = async (ownerType: string, ownerId: number, definitionId: number, stored: StoredBadge) => {
    const key = stateKey(ownerType, ownerId, definitionId);
    const previous = states.get(key) ?? null;
    if (sameState(previous, stored)) return;
    states.set(key, stored);
    pendingStates.push({ ownerType, ownerId, definitionId, state: stored });
    writes += 1;
    if (pendingStates.length >= STATE_WRITE_BATCH) await flushStateWrites(pendingStates);
  };
  const queueReviews = (definitionId: number, passIds: number[]) => {
    for (const passId of passIds) {
      const key = `${definitionId}:${passId}`;
      if (reviewKeys.has(key)) continue;
      reviewKeys.add(key);
      pendingReviews.push({ definitionId, passId });
    }
  };
  try {
    for (let ownerIndex = skip; ownerIndex < owners.length; ownerIndex += 1) {
      const owner = owners[ownerIndex];
      const audienceDefs = owner.defs.length ? owner.defs : definitions.filter((def) => def.audience === owner.audience);
      badgeTotal = audienceDefs.length;
      badgeCursor = 0;
      await stopIfCancelled(Number(job.id));
      const passes = owner.audience === 'player' ? passesByPlayer.get(owner.id) ?? [] : [];
      const userId = owner.audience === 'creator'
        ? catalog.creatorUsers[owner.id] ?? null
        : catalog.playerUsers[owner.id] ?? null;
      const difficultyCounts = prepareOwnerDifficultyCounts(
        catalog.charts,
        catalog.links,
        passes,
        owner.audience === 'creator' ? creatorDifficultyModes : playerDifficultyModes,
      );
      const rollups = computeRollups(
        {
          passes,
          charts: catalog.charts,
          links: catalog.links,
          ownerId: owner.id,
          difficultyCounts,
        },
        unionDemands(audienceDefs.map((def) => (
          def.reducer === 'value' ? planValueSource(def.params.expression || '', def.identity) : null
        ))),
      );
      const inputBase: Omit<OwnerInput, 'frozenIds' | 'since'> = {
        ownerId: owner.id,
        userId,
        passes,
        charts: catalog.charts,
        links: catalog.links,
        sets: catalog.sets,
        packLevels: catalog.packLevels,
        reviews: catalog.reviews,
        ratings: userId ? catalog.ratingsByUser[userId] ?? [] : [],
        world: catalog.world,
        difficultyCounts,
        rollups,
      };
      for (let index = 0; index < audienceDefs.length; index += 1) {
        const def = audienceDefs[index];
        if (!def.id) continue;
        await new Promise<void>((resolve) => setImmediate(resolve));
        throwIfBadgeCancelled();
        currentDefinitionId = def.id;
        currentOwnerId = owner.id;
        currentOwnerName = (owner.audience === 'creator' ? names.creators : names.players).get(owner.id) || null;
        badgeCursor = index + 1;
        await writeProgress();
        const previous = job.replaceState ? null : states.get(stateKey(def.audience, owner.id, def.id)) ?? null;
        const frozen = def.grant === 'persistSnapshot' && !job.replaceState ? previous?.snapshotIds ?? null : null;
        const started = performance.now();
        const result = evaluateBadge(def, { ...inputBase, frozenIds: frozen, since: def.publishedAt });
        const elapsed = performance.now() - started;
        const timing = definitionTimings.get(def.id) ?? { name: def.name, audience: def.audience, runs: 0, totalMs: 0 };
        timing.runs += 1;
        timing.totalMs += elapsed;
        definitionTimings.set(def.id, timing);
        skips.placeholder += result.skipPlaceholder;
        skips.unknownTime += result.skipUnknownTime;
        skips.missingDifficulty += result.skipMissingDifficulty;
        if (def.grant === 'manualLock' || def.backfill === 'queue') {
          queueReviews(def.id, result.reviewPassIds);
          if (pendingReviews.length >= REVIEW_WRITE_BATCH) await flushReviewWrites(pendingReviews);
        }
        throwIfBadgeCancelled();
        if (!(def.backfill === 'queue' && def.grant !== 'manualLock')) {
          const stored = applyGrant({
            grant: def.grant,
            labels: def.tierLabels,
            previous,
            next: result,
            replace: Boolean(job.replaceState),
            now,
          });
          await queueState(def.audience, owner.id, def.id, stored);
        }
        definitionCounts.set(def.id, (definitionCounts.get(def.id) ?? 0) + 1);
      }
      processed += 1;
      if (owner.audience === 'player') playersProcessed += 1;
      else creatorsProcessed += 1;
      if (pendingStates.length) await flushStateWrites(pendingStates);
      if (pendingReviews.length) await flushReviewWrites(pendingReviews);
      await writeProgress(true);
    }
  } finally {
    await flushStateWrites(pendingStates);
    await flushReviewWrites(pendingReviews);
  }
  return {
    summary: `Wrote ${writes} state rows for ${owners.length} owners.`,
    skips,
    timings: [...definitionTimings.entries()].map(([id, timing]) => ({ id, ...timing })),
  };
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let lockConn: Connection | null = null;
let haveLock = false;
let lockWarned = false;

const JOB_COLUMNS = 'id, scope, definitionId, playerId, creatorId, levelId, packId, replaceState, startFrom, ownerFrom, ownerTo, ownerKind, processed, dirt';

function workerLockName(): string {
  const database = (process.env.DB_DATABASE || 'tuf').replace(/[^A-Za-z0-9_]/g, '');
  return `tuf_badge_job_${database}`.slice(0, 64);
}

async function ensureWorkerLock(): Promise<boolean> {
  if (lockConn && haveLock) {
    try {
      await lockConn.query('SELECT 1');
      return true;
    } catch (error) {
      haveLock = false;
      const failed = lockConn;
      lockConn = null;
      if (failed) await failed.end().catch(() => undefined);
      if (!lockWarned) {
        lockWarned = true;
        logger.warn('[badges] job lock connection dropped', error);
      }
    }
  }
  try {
    lockConn = await mysql.createConnection({
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || '',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_DATABASE || '',
    });
    const [rows] = await lockConn.query(
      'SELECT GET_LOCK(?, 0) AS got',
      [workerLockName()],
    );
    const got = Array.isArray(rows) ? Number((rows[0] as { got?: number } | undefined)?.got) : 0;
    haveLock = got === 1;
    if (!haveLock) {
      await lockConn.end();
      lockConn = null;
    }
    return haveLock;
  } catch (error) {
    haveLock = false;
    const failed = lockConn;
    lockConn = null;
    if (failed) await failed.end().catch(() => undefined);
    if (!lockWarned) {
      lockWarned = true;
      logger.warn('[badges] could not lock the job worker', error);
    }
    return false;
  }
}

async function claimNextJob(): Promise<{ job: JobRow; resumed: boolean } | null> {
  return badgeDb().transaction(async (transaction) => {
    const runningJobs = await badgeDb().query<JobRow>(
      `SELECT ${JOB_COLUMNS}
       FROM badge_jobs WHERE status = 'running' ORDER BY id ASC LIMIT 1 FOR UPDATE`,
      { transaction, type: QueryTypes.SELECT },
    );
    if (runningJobs[0]) return { job: runningJobs[0], resumed: true };
    const pending = await badgeDb().query<JobRow>(
      `SELECT ${JOB_COLUMNS}
       FROM badge_jobs WHERE status = 'pending'
       ORDER BY
         CASE
           WHEN scope = 'dirty' AND (
             JSON_LENGTH(IFNULL(JSON_EXTRACT(dirt, '$.players'), JSON_ARRAY())) > 0
             OR JSON_LENGTH(IFNULL(JSON_EXTRACT(dirt, '$.creators'), JSON_ARRAY())) > 0
           ) THEN 0
           WHEN scope = 'dirty' AND JSON_LENGTH(IFNULL(JSON_EXTRACT(dirt, '$.levels'), JSON_ARRAY())) > 0 THEN 1
           WHEN scope = 'dirty' THEN 2
           WHEN scope = 'definition' THEN 3
           WHEN scope = 'all' THEN 4
           ELSE 5
         END,
         id ASC
       LIMIT 1 FOR UPDATE`,
      { transaction, type: QueryTypes.SELECT },
    );
    const job = pending[0];
    if (!job) return null;
    const updated = await badgeDb().query(
      `UPDATE badge_jobs
       SET status = 'running', startedAt = IFNULL(startedAt, NOW())
       WHERE id = :id AND status = 'pending'`,
      { transaction, replacements: { id: job.id }, type: QueryTypes.UPDATE },
    );
    if (affectedCount(updated) < 1) return null;
    return { job, resumed: false };
  });
}

async function tick(): Promise<void> {
  if (running || isShuttingDown()) return;
  if (!(await ensureWorkerLock())) return;
  running = true;
  let jobId = 0;
  try {
    const claimed = await claimNextJob();
    if (!claimed) return;
    jobId = Number(claimed.job.id);
    logger.info(`[badges] ${claimed.resumed ? 'resuming' : 'starting'} job ${jobId}`);
    watchBadgeJob(jobId);
    const outcome = await runBadgeJob(claimed.job);
    if (outcome.cancelled || isBadgeCancelRequested()) return;
    await badgeDb().query(
      `UPDATE badge_jobs
       SET status = 'done', phase = 'done', finishedAt = NOW(), summary = :summary,
           skipPlaceholder = :placeholder, skipUnknownTime = :unknownTime, skipMissingDifficulty = :missing,
           definitionTimings = CAST(:timings AS JSON)
       WHERE id = :id AND status = 'running'`,
      {
        replacements: {
          id: jobId,
          summary: outcome.summary,
          placeholder: outcome.skips.placeholder,
          unknownTime: outcome.skips.unknownTime,
          missing: outcome.skips.missingDifficulty,
          timings: JSON.stringify(outcome.timings ?? []),
        },
      },
    );
  } catch (error) {
    if (error instanceof BadgeJobCancelled || isBadgeCancelRequested()) {
      logger.info(`[badges] stopped cancelled job ${jobId}`);
      return;
    }
    if (isShuttingDown()) {
      logger.info(`[badges] leaving job ${jobId} running across shutdown`);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (!jobId && message.includes('badge_jobs') && message.toLowerCase().includes('exist')) {
      logger.warn('[badges] badge tables are not migrated yet');
      return;
    }
    logger.error('[badges] job failed', error);
    if (jobId) {
      await badgeDb().query(
        `UPDATE badge_jobs
         SET status = 'failed', finishedAt = NOW(), error = :error
         WHERE id = :id AND status = 'running'`,
        { replacements: { id: jobId, error: message } },
      ).catch(() => undefined);
    }
  } finally {
    stopBadgeWatch();
    running = false;
  }
}

export function startBadgeJobWorker(): void {
  if (timer) return;
  setBadgeWatchErrorHandler((error) => {
    logger.error('[badges] cancel watch failed', error);
  });
  timer = setInterval(() => {
    void tick();
  }, 2000);
  void tick();
  logger.info('[badges] Job worker started');
}

export function stopBadgeJobWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
  stopBadgeWatch();
}
