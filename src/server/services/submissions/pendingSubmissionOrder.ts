import { Op, fn, col } from 'sequelize';
import Difficulty from '@/models/levels/Difficulty.js';
import Level from '@/models/levels/Level.js';
import LevelSubmission from '@/models/submissions/LevelSubmission.js';
import { PassSubmission } from '@/models/submissions/PassSubmission.js';
import {
  comparePendingBySort,
  type PendingSubmissionSortDir,
} from './pendingSubmissionCursor.js';
import {
  difficultyTextSortValue,
  ratioSortValue,
  type PendingSubmissionSort,
} from './pendingSubmissionSort.js';

const ID_CHUNK = 500;

export type PendingKeyRow = {
  id: number;
  isLocked: boolean;
  createdAt: Date | string;
  userId: string | null;
  levelId: number | null;
  diff: string | null;
  sortValue: number | null;
  /** Accepted count. Used when `sortValue` is an accept/decline ratio. */
  sortTie: number | null;
  /** Accepted plus declined. Used after `sortTie` for ratio sorts. */
  sortVolume: number | null;
};

type StatusCountRow = {
  userId: string;
  status: string;
  count: string | number;
};

async function difficultyNameOrders(): Promise<Map<string, number>> {
  const difficulties = await Difficulty.findAll({ attributes: ['name', 'sortOrder'] });
  const byName = new Map<string, number>();
  for (const difficulty of difficulties) {
    const name = String(difficulty.name || '').trim().toLowerCase();
    const order = Number(difficulty.sortOrder);
    if (name && Number.isFinite(order)) byName.set(name, order);
  }
  return byName;
}

async function passDifficultyOrders(levelIds: Array<number | null>): Promise<Map<number, number>> {
  const unique = [...new Set(
    levelIds.filter((id): id is number => id != null && Number.isInteger(id) && id > 0),
  )];
  const orders = new Map<number, number>();
  for (let offset = 0; offset < unique.length; offset += ID_CHUNK) {
    const chunk = unique.slice(offset, offset + ID_CHUNK);
    const levels = await Level.findAll({
      where: { id: { [Op.in]: chunk } },
      attributes: ['id'],
      include: [{
        model: Difficulty,
        as: 'difficulty',
        attributes: ['sortOrder'],
        required: false,
      }],
    });
    for (const level of levels) {
      const difficulty = level.get('difficulty') as { sortOrder?: number | null } | null;
      const order = Number(difficulty?.sortOrder);
      if (Number.isFinite(order)) orders.set(level.id, order);
    }
  }
  return orders;
}

async function submitterRatioOrders(
  model: typeof LevelSubmission | typeof PassSubmission,
  userIds: Array<string | null>,
): Promise<Map<string, { ratio: number | null; accepted: number; total: number }>> {
  const unique = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  const totals = new Map<string, { accepted: number; declined: number }>();
  const finder = model as typeof LevelSubmission;
  for (let offset = 0; offset < unique.length; offset += ID_CHUNK) {
    const chunk = unique.slice(offset, offset + ID_CHUNK);
    const rows = await finder.findAll({
      where: {
        userId: { [Op.in]: chunk },
        status: { [Op.in]: ['approved', 'declined'] },
      },
      attributes: ['userId', 'status', [fn('COUNT', col('id')), 'count']],
      group: ['userId', 'status'],
      raw: true,
    }) as unknown as StatusCountRow[];
    for (const row of rows) {
      const current = totals.get(row.userId) ?? { accepted: 0, declined: 0 };
      const count = Number(row.count) || 0;
      if (row.status === 'approved') current.accepted = count;
      else if (row.status === 'declined') current.declined = count;
      totals.set(row.userId, current);
    }
  }

  const orders = new Map<string, { ratio: number | null; accepted: number; total: number }>();
  for (const [userId, stats] of totals) {
    orders.set(userId, {
      ratio: ratioSortValue(stats.accepted, stats.declined),
      accepted: stats.accepted,
      total: stats.accepted + stats.declined,
    });
  }
  return orders;
}

/** Fill `sortValue` for the active sort. Null means the row has nothing to rank on. */
export async function attachPendingSortValues(
  kind: 'level' | 'pass',
  rows: PendingKeyRow[],
  sort: PendingSubmissionSort,
): Promise<void> {
  if (sort === 'submitted') {
    for (const row of rows) {
      const time = new Date(row.createdAt).getTime();
      row.sortValue = Number.isFinite(time) ? time : null;
    }
    return;
  }

  if (sort === 'difficulty') {
    if (kind === 'pass') {
      const orders = await passDifficultyOrders(rows.map((row) => row.levelId));
      for (const row of rows) {
        const order = row.levelId == null ? undefined : orders.get(row.levelId);
        row.sortValue = order == null ? null : order;
      }
      return;
    }
    const names = await difficultyNameOrders();
    for (const row of rows) {
      row.sortValue = difficultyTextSortValue(row.diff, names);
    }
    return;
  }

  const ratios = await submitterRatioOrders(
    kind === 'pass' ? PassSubmission : LevelSubmission,
    rows.map((row) => row.userId),
  );
  for (const row of rows) {
    const rank = row.userId ? ratios.get(row.userId) : undefined;
    row.sortValue = rank?.ratio ?? null;
    row.sortTie = rank?.accepted ?? 0;
    row.sortVolume = rank?.total ?? 0;
  }
}

export function sortPendingKeys<T extends PendingKeyRow>(
  rows: T[],
  dir: PendingSubmissionSortDir,
): T[] {
  return [...rows].sort((a, b) => comparePendingBySort(a, b, dir));
}
