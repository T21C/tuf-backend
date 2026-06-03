import type { Transaction } from 'sequelize';
import LevelAnnouncementQueue from '@/models/levels/LevelAnnouncementQueue.js';
import type Level from '@/models/levels/Level.js';
import {
  type LevelAnnouncementFacet,
  type LevelAnnouncementKind,
  type LevelAnnouncementSnapshot,
} from '@/server/interfaces/models/index.js';
import {
  parseXaccCurveMeta,
  pickLevelXaccCurve,
  resolveXaccCurveConfig,
  XACC_CURVE_DEFAULTS,
} from '@/misc/utils/pass/scoreV2XaccCurve.js';

const SCORE_EPS = 1e-6;
const CURVE_EPS = 1e-9;

export type SnapshotFromLevelInput = {
  diffId?: number;
  baseScore?: number | null;
  ppBaseScore?: number | null;
  xaccCurveMeta?: unknown | null;
  difficulty?: { baseScore?: number | null } | null;
  previousDifficulty?: { baseScore?: number | null } | null;
};

export function snapshotFromLevel(
  level: SnapshotFromLevelInput,
  fieldOverrides?: {
    diffId?: number;
    baseScore?: number | null;
    difficulty?: { baseScore?: number | null } | null;
  },
): LevelAnnouncementSnapshot {
  const diffId = fieldOverrides?.diffId ?? level.diffId;
  const baseScore = fieldOverrides?.baseScore ?? level.baseScore ?? null;
  const difficulty =
    fieldOverrides?.difficulty ??
    level.difficulty ??
    level.previousDifficulty ??
    null;

  const overrides = pickLevelXaccCurve(level);
  const resolved = resolveXaccCurveConfig(overrides ?? null);
  const meta = parseXaccCurveMeta(level.xaccCurveMeta);
  const hasCustomCurve =
    meta != null &&
    (meta.poleOffset != null || meta.topMultiplier != null || overrides != null);

  const difficultyBaseScore = difficulty?.baseScore ?? null;

  return {
    diffId,
    baseScore,
    difficultyBaseScore,
    ppBaseScore: level.ppBaseScore ?? null,
    curve: hasCustomCurve
      ? {
          poleOffset: resolved.poleOffset,
          topMultiplier: resolved.topMultiplier,
        }
      : {
          poleOffset: XACC_CURVE_DEFAULTS.poleOffset,
          topMultiplier: XACC_CURVE_DEFAULTS.topMultiplier,
        },
  };
}

function scoresEqual(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) < SCORE_EPS;
}

function curvesEqual(
  a: LevelAnnouncementSnapshot['curve'],
  b: LevelAnnouncementSnapshot['curve'],
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    Math.abs(a.poleOffset - b.poleOffset) < CURVE_EPS &&
    Math.abs(a.topMultiplier - b.topMultiplier) < CURVE_EPS
  );
}

export function computeAnnouncementFacets(
  before: LevelAnnouncementSnapshot,
  after: LevelAnnouncementSnapshot,
): LevelAnnouncementFacet[] {
  const facets: LevelAnnouncementFacet[] = [];
  if (before.diffId !== after.diffId) facets.push('DIFF');
  if (
    !scoresEqual(
      before.baseScore || before.difficultyBaseScore || 0,
      after.baseScore || after.difficultyBaseScore || 0,
    )
  ) {
    facets.push('BASE_SCORE');
  }
  if (!scoresEqual(before.ppBaseScore || 0, after.ppBaseScore || 0)) {
    facets.push('PP_BASE_SCORE');
  }
  if (!curvesEqual(before.curve, after.curve)) facets.push('CURVE');
  return facets;
}

export function hasMeaningfulAnnouncementChange(facets: LevelAnnouncementFacet[]): boolean {
  return facets.length > 0;
}

function unionFacets(
  existing: LevelAnnouncementFacet[],
  incoming: LevelAnnouncementFacet[],
): LevelAnnouncementFacet[] {
  const order: LevelAnnouncementFacet[] = [
    'DIFF',
    'BASE_SCORE',
    'PP_BASE_SCORE',
    'CURVE',
  ];
  const set = new Set([...existing, ...incoming]);
  return order.filter(f => set.has(f));
}

export type EnqueueLevelAnnouncementArgs = {
  levelId: number;
  kind: LevelAnnouncementKind;
  before: LevelAnnouncementSnapshot;
  after: LevelAnnouncementSnapshot;
  facets?: LevelAnnouncementFacet[];
  enqueuedBy?: string | null;
  transaction?: Transaction;
};

/**
 * Creates or coalesces a PENDING queue row for a level.
 * Keeps earliest `before`, latest `after`, unions facets.
 * Skips when net delta is empty after coalescing.
 */
export async function enqueueLevelAnnouncement(
  args: EnqueueLevelAnnouncementArgs,
): Promise<LevelAnnouncementQueue | null> {
  const incomingFacets = args.facets ?? computeAnnouncementFacets(args.before, args.after);
  if (!hasMeaningfulAnnouncementChange(incomingFacets)) {
    return null;
  }

  const existing = await LevelAnnouncementQueue.findOne({
    where: { levelId: args.levelId, status: 'PENDING' },
    transaction: args.transaction,
    lock: args.transaction ? args.transaction.LOCK.UPDATE : undefined,
  });

  if (existing) {
    const mergedBefore = existing.before;
    const mergedAfter = { ...args.after };
    const mergedFacets = unionFacets(existing.facets, incomingFacets);
    const mergedKind =
      existing.kind === 'NEW' || args.kind === 'NEW' ? 'NEW' : 'RERATE';

    if (!hasMeaningfulAnnouncementChange(mergedFacets)) {
      await existing.update(
        { status: 'SKIPPED', pendingUniqueKey: null },
        { transaction: args.transaction },
      );
      return existing;
    }

    const netFacets = computeAnnouncementFacets(mergedBefore, mergedAfter);
    if (!hasMeaningfulAnnouncementChange(netFacets)) {
      await existing.update(
        {
          status: 'SKIPPED',
          pendingUniqueKey: null,
          facets: mergedFacets,
          after: mergedAfter,
        },
        { transaction: args.transaction },
      );
      return existing;
    }

    await existing.update(
      {
        kind: mergedKind,
        facets: unionFacets(mergedFacets, netFacets),
        after: mergedAfter,
        enqueuedBy: args.enqueuedBy ?? existing.enqueuedBy,
      },
      { transaction: args.transaction },
    );
    return existing;
  }

  const netFacets = computeAnnouncementFacets(args.before, args.after);
  if (!hasMeaningfulAnnouncementChange(netFacets)) {
    return null;
  }

  return LevelAnnouncementQueue.create(
    {
      levelId: args.levelId,
      kind: args.kind,
      facets: incomingFacets,
      before: args.before,
      after: args.after,
      status: 'PENDING',
      pendingUniqueKey: args.levelId,
      enqueuedBy: args.enqueuedBy ?? null,
    },
    { transaction: args.transaction },
  );
}

export function buildSnapshotsFromLevels(
  oldLevel: Level,
  newLevel: Level,
  options?: { useFrozenPreviousAsBefore?: boolean },
): { before: LevelAnnouncementSnapshot; after: LevelAnnouncementSnapshot } {
  const useFrozen = options?.useFrozenPreviousAsBefore === true;
  const frozenDiffId = oldLevel.previousDiffId;
  const hasFrozenPrevious =
    useFrozen && frozenDiffId != null && frozenDiffId !== 0;

  const before = hasFrozenPrevious
    ? snapshotFromLevel(oldLevel, {
        diffId: frozenDiffId,
        baseScore: oldLevel.previousBaseScore ?? null,
        difficulty: (oldLevel as SnapshotFromLevelInput).previousDifficulty ?? null,
      })
    : snapshotFromLevel(oldLevel);

  return { before, after: snapshotFromLevel(newLevel) };
}

export async function skipPendingAnnouncement(
  levelId: number,
  transaction?: Transaction,
): Promise<void> {
  await LevelAnnouncementQueue.update(
    { status: 'SKIPPED', pendingUniqueKey: null },
    {
      where: { levelId, status: 'PENDING' },
      transaction,
    },
  );
}

export async function markQueueRowsAnnounced(
  queueRowIds: number[],
  transaction?: Transaction,
): Promise<void> {
  if (queueRowIds.length === 0) return;
  await LevelAnnouncementQueue.update(
    {
      status: 'ANNOUNCED',
      pendingUniqueKey: null,
      announcedAt: new Date(),
    },
    {
      where: { id: queueRowIds, status: 'PENDING' },
      transaction,
    },
  );
}

export async function markQueueRowsSkipped(
  queueRowIds: number[],
  transaction?: Transaction,
): Promise<void> {
  if (queueRowIds.length === 0) return;
  await LevelAnnouncementQueue.update(
    {
      status: 'SKIPPED',
      pendingUniqueKey: null,
    },
    {
      where: { id: queueRowIds, status: 'PENDING' },
      transaction,
    },
  );
}

export type LevelAnnouncementSyncContext = {
  oldLevel: {
    id: number;
    diffId?: number;
    baseScore?: number | null;
    ppBaseScore?: number | null;
    xaccCurveMeta?: unknown | null;
    toRate?: boolean;
    previousDiffId?: number | null;
  };
  newLevel: {
    id: number;
    diffId?: number;
    baseScore?: number | null;
    ppBaseScore?: number | null;
    xaccCurveMeta?: unknown | null;
    toRate?: boolean;
    previousDiffId?: number | null;
  };
  toRateTransition?: boolean | null;
  enqueuedBy?: string | null;
  transaction?: Transaction;
};

/**
 * Called after a level save to enqueue or skip announcement queue rows.
 */
export async function syncAnnouncementQueueAfterLevelSave(
  ctx: LevelAnnouncementSyncContext,
): Promise<void> {
  const enteringRating =
    ctx.toRateTransition === true &&
    ctx.oldLevel.toRate === false &&
    ctx.newLevel.toRate === true;

  if (enteringRating) {
    await skipPendingAnnouncement(ctx.oldLevel.id, ctx.transaction);
    return;
  }

  const stillInRating =
    ctx.newLevel.toRate === true && ctx.toRateTransition !== false;
  if (stillInRating) {
    return;
  }

  const ratingJustSettled =
    ctx.toRateTransition === false &&
    ctx.oldLevel.toRate === true &&
    ctx.newLevel.toRate === false;

  const { before, after } = buildSnapshotsFromLevels(
    ctx.oldLevel as Level,
    ctx.newLevel as Level,
    { useFrozenPreviousAsBefore: ratingJustSettled },
  );
  const facets = computeAnnouncementFacets(before, after);
  if (!hasMeaningfulAnnouncementChange(facets)) {
    return;
  }

  const isFirstRating =
    ratingJustSettled &&
    (ctx.oldLevel.previousDiffId == null ||
      ctx.oldLevel.previousDiffId === 0);

  const kind = isFirstRating ? 'NEW' : 'RERATE';

  await enqueueLevelAnnouncement({
    levelId: ctx.newLevel.id,
    kind,
    before,
    after,
    facets,
    enqueuedBy: ctx.enqueuedBy ?? null,
    transaction: ctx.transaction,
  });
}

export async function syncAnnouncementQueueAfterCurveChange(args: {
  levelId: number;
  beforeLevel: {
    diffId?: number;
    baseScore?: number | null;
    ppBaseScore?: number | null;
    xaccCurveMeta?: unknown | null;
  };
  afterLevel: {
    diffId?: number;
    baseScore?: number | null;
    ppBaseScore?: number | null;
    xaccCurveMeta?: unknown | null;
  };
  enqueuedBy?: string | null;
}): Promise<LevelAnnouncementQueue | null> {
  const before = snapshotFromLevel(args.beforeLevel);
  const after = snapshotFromLevel(args.afterLevel);
  const facets = computeAnnouncementFacets(before, after).filter(f => f === 'CURVE');
  if (facets.length === 0) {
    return null;
  }
  return enqueueLevelAnnouncement({
    levelId: args.levelId,
    kind: 'RERATE',
    before,
    after,
    facets,
    enqueuedBy: args.enqueuedBy ?? null,
  });
}
