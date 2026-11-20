import { QueryTypes } from 'sequelize';
import { getSequelizeForModelGroup } from '@/config/db.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { evaluateBadge, type OwnerInput } from '../engine/evaluate.js';
import { applyGrant, type StoredBadge } from '../engine/grant.js';
import { loadBadgeCatalog, type BadgeCatalog } from '../catalog/load.js';
import type { BadgeDraft } from '../engine/params.js';
import { definitionFromRow, type DefinitionRow } from './definitions.js';

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
  processed: number;
};

function badgeDb() {
  return getSequelizeForModelGroup('badges');
}

async function select<T>(sql: string, replacements?: Record<string, unknown>): Promise<T[]> {
  return badgeDb().query(sql, { replacements, type: QueryTypes.SELECT }) as Promise<T[]>;
}

function needsWorld(def: BadgeDraft): boolean {
  return (
    def.reducer === 'record' ||
    def.reducer === 'nthClearer' ||
    (def.reducer === 'pattern' && def.params.sharedAccuracy === true) ||
    (def.reducer === 'manual' && def.params.pattern?.sharedAccuracy === true) ||
    (def.reducer === 'value' && /\b(nth|lead|shared|first)\s*\(/.test(def.params.expression || ''))
  );
}

async function loadDefinitions(job: JobRow): Promise<BadgeDraft[]> {
  const sql = job.definitionId
    ? 'SELECT * FROM badge_definitions WHERE id = :id'
    : 'SELECT * FROM badge_definitions WHERE enabled = 1';
  const rows = await select<DefinitionRow>(sql, { id: job.definitionId });
  return rows.map(definitionFromRow).filter((row): row is BadgeDraft => row != null && row.enabled);
}

async function playerIdsForLevel(levelId: number): Promise<number[]> {
  const rows = await select<{ playerId: number }>(
    'SELECT DISTINCT playerId FROM passes WHERE levelId = :levelId',
    { levelId },
  );
  return rows.map((row) => Number(row.playerId));
}

async function readState(ownerType: string, ownerId: number, definitionId: number): Promise<StoredBadge | null> {
  const rows = await select<{
    tier: number; credit: number; barFrom: number; barTo: number; barValue: number;
    provingPassIds: unknown; earnedAt: Date | null; snapshotIds: unknown;
  }>(
    `SELECT tier, credit, barFrom, barTo, barValue, provingPassIds, earnedAt, snapshotIds
     FROM badge_states
     WHERE ownerType = :ownerType AND ownerId = :ownerId AND definitionId = :definitionId`,
    { ownerType, ownerId, definitionId },
  );
  const row = rows[0];
  if (!row) return null;
  return {
    tier: Number(row.tier) || 0,
    credit: Number(row.credit) || 0,
    barFrom: Number(row.barFrom) || 0,
    barTo: Number(row.barTo) || 0,
    barValue: Number(row.barValue) || 0,
    provingPassIds: Array.isArray(row.provingPassIds) ? row.provingPassIds.map(Number) : [],
    earnedAt: row.earnedAt ? new Date(row.earnedAt).toISOString() : null,
    tierLabel: null,
    snapshotIds: Array.isArray(row.snapshotIds) ? row.snapshotIds.map(Number) : null,
  };
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
        currentOwnerName: progress.currentOwnerName,
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

async function writeState(ownerType: string, ownerId: number, definitionId: number, state: StoredBadge): Promise<void> {
  await badgeDb().query(
    `INSERT INTO badge_states
      (ownerType, ownerId, definitionId, tier, credit, barFrom, barTo, barValue, provingPassIds, earnedAt, tierLabel, snapshotIds, createdAt, updatedAt)
     VALUES
      (:ownerType, :ownerId, :definitionId, :tier, :credit, :barFrom, :barTo, :barValue, CAST(:proving AS JSON), :earnedAt, :tierLabel, CAST(:snapshot AS JSON), NOW(), NOW())
     ON DUPLICATE KEY UPDATE
      tier = VALUES(tier), credit = VALUES(credit), barFrom = VALUES(barFrom), barTo = VALUES(barTo),
      barValue = VALUES(barValue), provingPassIds = VALUES(provingPassIds), earnedAt = VALUES(earnedAt),
      tierLabel = VALUES(tierLabel), snapshotIds = VALUES(snapshotIds), updatedAt = NOW()`,
    {
      replacements: {
        ownerType,
        ownerId,
        definitionId,
        tier: state.tier,
        credit: state.credit,
        barFrom: state.barFrom,
        barTo: state.barTo,
        barValue: state.barValue,
        proving: JSON.stringify(state.provingPassIds),
        earnedAt: state.earnedAt ? new Date(state.earnedAt) : null,
        tierLabel: state.tierLabel,
        snapshot: state.snapshotIds ? JSON.stringify(state.snapshotIds) : 'null',
      },
    },
  );
}

async function ensureReviews(definitionId: number, passIds: number[]): Promise<void> {
  for (const passId of passIds) {
    await badgeDb().query(
      `INSERT IGNORE INTO badge_reviews (definitionId, passId, videoUrl, status, createdAt, updatedAt)
       VALUES (:definitionId, :passId, '', 'pending', NOW(), NOW())`,
      { replacements: { definitionId, passId } },
    );
  }
}

async function ownersFor(job: JobRow, defs: BadgeDraft[], catalog: BadgeCatalog): Promise<{ audience: 'player' | 'creator'; id: number }[]> {
  if (job.scope === 'player' && job.playerId) return [{ audience: 'player', id: Number(job.playerId) }];
  if (job.scope === 'creator' && job.creatorId) return [{ audience: 'creator', id: Number(job.creatorId) }];
  const out: { audience: 'player' | 'creator'; id: number }[] = [];
  const wantPlayer = defs.some((def) => def.audience === 'player');
  const wantCreator = defs.some((def) => def.audience === 'creator');
  if (job.scope === 'chart' && job.levelId) {
    if (wantPlayer) {
      const ids = new Set(catalog.passes.filter((pass) => pass.levelId === Number(job.levelId)).map((pass) => pass.playerId));
      for (const id of await playerIdsForLevel(Number(job.levelId))) ids.add(id);
      for (const id of ids) out.push({ audience: 'player', id });
    }
    if (wantCreator) {
      const ids = new Set<number>();
      const chart = catalog.charts.find((item) => item.id === Number(job.levelId));
      for (const id of chart?.charterIds ?? []) ids.add(id);
      for (const id of chart?.vfxerIds ?? []) ids.add(id);
      if (job.creatorId) ids.add(Number(job.creatorId));
      for (const id of ids) out.push({ audience: 'creator', id });
    }
    return out;
  }
  if (wantPlayer) {
    for (const id of new Set(catalog.passes.map((pass) => pass.playerId))) out.push({ audience: 'player', id });
  }
  if (wantCreator) {
    const ids = new Set<number>();
    for (const chart of catalog.charts) {
      for (const id of chart.charterIds) ids.add(id);
      for (const id of chart.vfxerIds) ids.add(id);
    }
    for (const id of ids) out.push({ audience: 'creator', id });
  }
  return out;
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
  const resumeAt = Math.max(0, Math.floor(Number(job.startFrom) || 0), Math.floor(Number(job.processed) || 0));
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
  const definitions = (await loadDefinitions(job)).filter((def) => {
    if (job.scope === 'pack' && !(def.reducer === 'pack' || (def.reducer === 'value' && def.params.packId))) return false;
    if (job.scope === 'pack' && job.packId && def.params.packId !== Number(job.packId)) return false;
    return true;
  });
  const catalog = await loadBadgeCatalog({
    playerIds: job.scope === 'player' && job.playerId ? [Number(job.playerId)] : undefined,
    needWorld: definitions.some(needsWorld),
  });
  const passesByPlayer = new Map<number, BadgeCatalog['passes']>();
  for (const pass of catalog.passes) {
    const list = passesByPlayer.get(pass.playerId);
    if (list) list.push(pass);
    else passesByPlayer.set(pass.playerId, [pass]);
  }
  const owners = await ownersFor(job, definitions, catalog);
  const names = await ownerNames();
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
  for (let ownerIndex = skip; ownerIndex < owners.length; ownerIndex += 1) {
    const owner = owners[ownerIndex];
    const audienceDefs = definitions.filter((def) => def.audience === owner.audience);
    badgeTotal = audienceDefs.length;
    badgeCursor = 0;
    const passes = owner.audience === 'player' ? passesByPlayer.get(owner.id) ?? [] : [];
    const userId = owner.audience === 'creator'
      ? catalog.creatorUsers[owner.id] ?? null
      : catalog.playerUsers[owner.id] ?? null;
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
    };
    for (let index = 0; index < audienceDefs.length; index += 1) {
      const def = audienceDefs[index];
      if (!def.id) continue;
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (await isCancelled(Number(job.id))) {
        return { summary: 'Cancelled', skips, cancelled: true };
      }
      currentDefinitionId = def.id;
      currentOwnerId = owner.id;
      currentOwnerName = (owner.audience === 'creator' ? names.creators : names.players).get(owner.id) || null;
      badgeCursor = index + 1;
      await writeJobProgress(Number(job.id), progressPayload('running'));
      const previous = job.replaceState ? null : await readState(def.audience, owner.id, def.id);
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
        await ensureReviews(def.id, result.reviewPassIds);
      }
      if (!(def.backfill === 'queue' && def.grant !== 'manualLock')) {
        const stored = applyGrant({
          grant: def.grant,
          labels: def.tierLabels,
          previous,
          next: result,
          replace: Boolean(job.replaceState),
          now,
        });
        await writeState(def.audience, owner.id, def.id, stored);
        writes += 1;
      }
      definitionCounts.set(def.id, (definitionCounts.get(def.id) ?? 0) + 1);
      await writeJobProgress(Number(job.id), progressPayload('running'));
    }
    processed += 1;
    if (owner.audience === 'player') playersProcessed += 1;
    else creatorsProcessed += 1;
    await writeJobProgress(Number(job.id), progressPayload('running'));
  }
  return {
    summary: `Wrote ${writes} state rows for ${owners.length} owners.`,
    skips,
    timings: [...definitionTimings.entries()].map(([id, timing]) => ({ id, ...timing })),
  };
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  let jobId = 0;
  try {
    const claimed = await badgeDb().transaction(async (transaction) => {
      const pending = await badgeDb().query<JobRow>(
        `SELECT id, scope, definitionId, playerId, creatorId, levelId, packId, replaceState, startFrom, processed
         FROM badge_jobs WHERE status = 'pending' ORDER BY id ASC LIMIT 1 FOR UPDATE`,
        { transaction, type: QueryTypes.SELECT },
      );
      const job = pending[0];
      if (!job) return null;
      await badgeDb().query(
        `UPDATE badge_jobs SET status = 'running', startedAt = NOW() WHERE id = :id`,
        { transaction, replacements: { id: job.id } },
      );
      return job;
    });
    if (!claimed) return;
    jobId = Number(claimed.id);
    const outcome = await runBadgeJob(claimed);
    if (outcome.cancelled) return;
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
    const message = error instanceof Error ? error.message : String(error);
    if (!jobId && message.includes('badge_jobs') && message.toLowerCase().includes('exist')) {
      logger.warn('[badges] badge tables are not migrated yet');
      return;
    }
    logger.error('[badges] job failed', error);
    if (jobId) {
      await badgeDb().query(
        `UPDATE badge_jobs SET status = 'failed', finishedAt = NOW(), error = :error WHERE id = :id`,
        { replacements: { id: jobId, error: error instanceof Error ? error.message : String(error) } },
      ).catch(() => undefined);
    }
  } finally {
    running = false;
  }
}

export function startBadgeJobWorker(): void {
  if (timer) return;
  void badgeDb().query(
    `UPDATE badge_jobs SET status = 'pending', startedAt = NULL WHERE status = 'running'`,
  ).catch((error) => {
    logger.warn('[badges] could not resume an interrupted job', error);
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
}
