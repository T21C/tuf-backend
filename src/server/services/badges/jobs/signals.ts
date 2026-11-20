import type { Transaction } from 'sequelize';
import { QueryTypes } from 'sequelize';
import { getSequelizeForModelGroup } from '@/config/db.js';
import { logger } from '@/server/services/core/LoggerService.js';

export type BadgeSignal = {
  scope: 'definition' | 'player' | 'creator' | 'chart' | 'pack' | 'all';
  definitionId?: number | null;
  playerId?: number | null;
  creatorId?: number | null;
  levelId?: number | null;
  packId?: number | null;
  replaceState?: boolean;
  startFrom?: number;
};

function afterCommit(transaction: Transaction | null | undefined, run: () => void) {
  const hook = transaction as (Transaction & { afterCommit?: (fn: () => void) => void }) | null | undefined;
  if (hook && typeof hook.afterCommit === 'function') {
    hook.afterCommit(run);
    return;
  }
  run();
}

export async function enqueueBadgeJob(signal: BadgeSignal): Promise<void> {
  const sequelize = getSequelizeForModelGroup('badges');
  const startFrom = Math.max(0, Math.floor(Number(signal.startFrom) || 0));
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
      },
      type: QueryTypes.SELECT,
    },
  );
  if (existing.length) return;
  await sequelize.query(
    `INSERT INTO badge_jobs
      (scope, definitionId, playerId, creatorId, levelId, packId, replaceState, startFrom, status, createdAt)
     VALUES (:scope, :definitionId, :playerId, :creatorId, :levelId, :packId, :replaceState, :startFrom, 'pending', NOW())`,
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
