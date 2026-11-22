import type { Transaction } from 'sequelize';
import { QueryTypes } from 'sequelize';
import { getSequelizeForModelGroup } from '@/config/db.js';
import { logger } from '@/server/services/core/LoggerService.js';
import {
  dirtIsEmpty,
  mergeDirt,
  parseDirt,
  planDirtEnqueue,
  type BadgeDirt,
  type BadgeDirtPatch,
} from './dirt.js';
import { ownerRangeFrom, parseOwnerKind, type OwnerKind } from './owners.js';

export type BadgeSignal = {
  scope: 'definition' | 'player' | 'creator' | 'chart' | 'pack' | 'all' | 'dirty';
  definitionId?: number | null;
  playerId?: number | null;
  creatorId?: number | null;
  levelId?: number | null;
  packId?: number | null;
  replaceState?: boolean;
  startFrom?: number;
  ownerFrom?: number | null;
  ownerTo?: number | null;
  ownerKind?: OwnerKind | null;
  dirt?: BadgeDirtPatch;
};

function afterCommit(transaction: Transaction | null | undefined, run: () => void) {
  const hook = transaction as (Transaction & { afterCommit?: (fn: () => void) => void }) | null | undefined;
  if (hook && typeof hook.afterCommit === 'function') {
    hook.afterCommit(run);
    return;
  }
  run();
}

function signalToDirt(signal: BadgeSignal): BadgeDirtPatch {
  if (signal.dirt) return signal.dirt;
  return {
    players: signal.playerId ? [Number(signal.playerId)] : [],
    creators: signal.creatorId ? [Number(signal.creatorId)] : [],
    levels: signal.levelId ? [Number(signal.levelId)] : [],
    packs: signal.packId ? [Number(signal.packId)] : [],
    catalog: false,
  };
}

export async function enqueueBadgeDirt(patch: BadgeDirtPatch): Promise<void> {
  const sequelize = getSequelizeForModelGroup('badges');
  await sequelize.transaction(async (transaction) => {
    const blocking = await sequelize.query<{ id: number }>(
      `SELECT id FROM badge_jobs
       WHERE scope = 'all' AND status IN ('pending', 'running')
       LIMIT 1`,
      { transaction, type: QueryTypes.SELECT },
    );
    const pending = await sequelize.query<{ id: number; dirt: unknown }>(
      `SELECT id, dirt FROM badge_jobs
       WHERE status = 'pending' AND scope = 'dirty' AND replaceState = 0
       ORDER BY id ASC
       LIMIT 1
       FOR UPDATE`,
      { transaction, type: QueryTypes.SELECT },
    );
    const action = planDirtEnqueue(blocking.length > 0, pending.length > 0);
    if (action === 'drop') return;
    const merged = mergeDirt(parseDirt(pending[0]?.dirt), patch);
    if (dirtIsEmpty(merged)) return;
    if (action === 'merge' && pending[0]) {
      await sequelize.query(
        `UPDATE badge_jobs SET dirt = CAST(:dirt AS JSON) WHERE id = :id AND status = 'pending'`,
        {
          transaction,
          replacements: { id: pending[0].id, dirt: JSON.stringify(merged) },
        },
      );
      return;
    }
    await sequelize.query(
      `INSERT INTO badge_jobs
        (scope, definitionId, playerId, creatorId, levelId, packId, replaceState, startFrom, status, dirt, createdAt)
       VALUES ('dirty', NULL, NULL, NULL, NULL, NULL, 0, 0, 'pending', CAST(:dirt AS JSON), NOW())`,
      { transaction, replacements: { dirt: JSON.stringify(merged) } },
    );
  });
}

export async function enqueueBadgeJob(signal: BadgeSignal): Promise<void> {
  if (signal.scope === 'dirty' || signal.scope === 'chart' || signal.scope === 'player' || signal.scope === 'creator' || signal.scope === 'pack') {
    await enqueueBadgeDirt(signalToDirt(signal));
    return;
  }
  const sequelize = getSequelizeForModelGroup('badges');
  const { ownerFrom, ownerTo } = ownerRangeFrom(signal);
  const startFrom = ownerFrom ?? 0;
  const ownerKind = parseOwnerKind(signal.ownerKind);
  const existing = await sequelize.query<{ id: number }>(
    `SELECT id FROM badge_jobs
     WHERE status = 'pending' AND scope = :scope
       AND IFNULL(definitionId, 0) = IFNULL(:definitionId, 0)
       AND IFNULL(playerId, 0) = IFNULL(:playerId, 0)
       AND IFNULL(creatorId, 0) = IFNULL(:creatorId, 0)
       AND IFNULL(levelId, 0) = IFNULL(:levelId, 0)
       AND IFNULL(packId, 0) = IFNULL(:packId, 0)
       AND replaceState = :replaceState
       AND IFNULL(startFrom, 0) = IFNULL(:startFrom, 0)
       AND IFNULL(ownerFrom, 0) = IFNULL(:ownerFrom, 0)
       AND IFNULL(ownerTo, 0) = IFNULL(:ownerTo, 0)
       AND IFNULL(ownerKind, '') = IFNULL(:ownerKind, '')
     LIMIT 1`,
    {
      replacements: {
        scope: signal.scope,
        definitionId: signal.definitionId ?? null,
        playerId: signal.playerId ?? null,
        creatorId: signal.creatorId ?? null,
        levelId: signal.levelId ?? null,
        packId: signal.packId ?? null,
        replaceState: signal.replaceState ? 1 : 0,
        startFrom,
        ownerFrom,
        ownerTo,
        ownerKind,
      },
      type: QueryTypes.SELECT,
    },
  );
  if (existing.length) return;
  await sequelize.query(
    `INSERT INTO badge_jobs
      (scope, definitionId, playerId, creatorId, levelId, packId, replaceState, startFrom, ownerFrom, ownerTo, ownerKind, status, createdAt)
     VALUES (:scope, :definitionId, :playerId, :creatorId, :levelId, :packId, :replaceState, :startFrom, :ownerFrom, :ownerTo, :ownerKind, 'pending', NOW())`,
    {
      replacements: {
        scope: signal.scope,
        definitionId: signal.definitionId ?? null,
        playerId: signal.playerId ?? null,
        creatorId: signal.creatorId ?? null,
        levelId: signal.levelId ?? null,
        packId: signal.packId ?? null,
        replaceState: signal.replaceState ? 1 : 0,
        startFrom,
        ownerFrom,
        ownerTo,
        ownerKind,
      },
    },
  );
}

export function signalBadgeJob(signal: BadgeSignal, transaction?: Transaction | null): void {
  afterCommit(transaction, () => {
    void enqueueBadgeJob(signal).catch((error) => {
      logger.error('[badges] enqueue failed', error);
    });
  });
}

export function signalBadgeDirt(patch: BadgeDirtPatch, transaction?: Transaction | null): void {
  afterCommit(transaction, () => {
    void enqueueBadgeDirt(patch).catch((error) => {
      logger.error('[badges] enqueue dirt failed', error);
    });
  });
}

export function signalLevelIdentityDirt(levelId: number, transaction?: Transaction | null): void {
  afterCommit(transaction, () => {
    void (async () => {
      const sequelize = getSequelizeForModelGroup('badges');
      const rows = await sequelize.query<{ playerId: number }>(
        `SELECT DISTINCT playerId FROM passes
         WHERE levelId = :levelId AND IFNULL(isDeleted, 0) = 0 AND IFNULL(isHidden, 0) = 0`,
        { replacements: { levelId }, type: QueryTypes.SELECT },
      );
      await enqueueBadgeDirt({
        catalog: true,
        levels: [levelId],
        players: rows.map((row) => Number(row.playerId)),
      });
    })().catch((error) => {
      logger.error('[badges] enqueue identity dirt failed', error);
    });
  });
}

export type { BadgeDirt, BadgeDirtPatch };
