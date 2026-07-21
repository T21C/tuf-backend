import Curation from '@/models/curations/Curation.js';
import CurationType from '@/models/curations/CurationType.js';
import CurationSchedule from '@/models/curations/CurationSchedule.js';
import Level from '@/models/levels/Level.js';
import { logger } from '@/server/services/core/LoggerService.js';

export const FILL_TARGET = 15;
export const MAX_SLOTS = 20;
export const REFEATURE_COOLDOWN_WEEKS = 8;

export type ListType = 'primary' | 'secondary';
export type FillHalls = ListType | 'both';
export type FillMode = 'cron' | 'manual';

export interface FillWeekArgs {
  weekStart: Date | string;
  halls: FillHalls;
  scheduledBy: string;
  mode: FillMode;
}

export interface FillWeekResult {
  skipped: boolean;
  reason?: string;
  weekStart: Date;
  created: number;
  perHall: Record<ListType, number>;
}

// Ideal full-hall tier compositions, ordered highest priority first.
// Legendary: 2x tier-3, 13x tier-2. Loved: 5x tier-2, 8x tier-1, 2x tier-0.
const PRIMARY_COMPOSITION: number[] = [3, 3, ...Array<number>(13).fill(2)];
const SECONDARY_COMPOSITION: number[] = [
  2, 2, 2, 2, 2,
  ...Array<number>(8).fill(1),
  0, 0,
];

// Fallthrough desirability per hall, most desired tier first.
const HALL_TIER_DESIRABILITY: Record<ListType, number[]> = {
  primary: [3, 2, 1, 0],
  secondary: [2, 1, 0, 3],
};

// Allowed digit range per curation-type letter. O0 and H0/H3 are intentionally
// excluded; anything else (e.g. Epic) simply does not match and is ignored.
const TIER_RANGES: Record<string, [number, number]> = {
  C: [0, 3],
  V: [0, 3],
  O: [1, 3],
  H: [1, 2],
};

const ALL_TIERS = [0, 1, 2, 3] as const;

/**
 * Highest eligible tier digit across a curation's types, or null when the
 * curation carries no tier-bearing type and should be skipped entirely.
 */
export function scoreCuration(types: { name: string }[] | undefined): number | null {
  if (!types || types.length === 0) return null;
  let best: number | null = null;
  for (const type of types) {
    const match = /^([CVOH])([0-9])$/.exec((type.name ?? '').trim());
    if (!match) continue;
    const range = TIER_RANGES[match[1]];
    if (!range) continue;
    const digit = Number(match[2]);
    if (digit < range[0] || digit > range[1]) continue;
    if (best === null || digit > best) best = digit;
  }
  return best;
}

/** Normalize any date to that week's Monday at 00:00:00 UTC. */
export function getWeekStartMonday(date: Date | string): Date {
  const input = new Date(date);
  const dayOfWeek = input.getUTCDay();
  const daysToSubtract = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(input);
  monday.setUTCDate(input.getUTCDate() - daysToSubtract);
  monday.setUTCHours(0, 0, 0, 0);
  return monday;
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

type TierBuckets = Record<number, number[]>;

interface EligiblePool {
  fresh: TierBuckets;
  refeature: TierBuckets;
  tierById: Map<number, number>;
}

/**
 * For a demanded tier, order candidate tiers by proximity then hall preference,
 * so exact matches come first and fallthrough spreads to the nearest tiers.
 */
function tierCandidateOrder(demandedTier: number, hall: ListType): number[] {
  const desirability = HALL_TIER_DESIRABILITY[hall];
  return [...ALL_TIERS].sort((a, b) => {
    const distA = Math.abs(a - demandedTier);
    const distB = Math.abs(b - demandedTier);
    if (distA !== distB) return distA - distB;
    return desirability.indexOf(a) - desirability.indexOf(b);
  });
}

/** Pop one curation id for a demanded tier, preferring never-featured then exact tier. */
function popForTier(pool: EligiblePool, hall: ListType, demandedTier: number): number | null {
  for (const tier of tierCandidateOrder(demandedTier, hall)) {
    const fresh = pool.fresh[tier];
    if (fresh.length) return fresh.pop() as number;
    const refeature = pool.refeature[tier];
    if (refeature.length) return refeature.pop() as number;
  }
  return null;
}

/**
 * Reduce the ideal full-hall composition by what the hall already holds, leaving
 * the ordered list of tiers still to be picked (length = remaining deficit).
 */
function buildTierDemand(fullComposition: number[], existingTiers: (number | null)[]): number[] {
  const remaining = [...fullComposition];
  for (const existing of existingTiers) {
    if (remaining.length === 0) break;
    const idx = existing === null ? -1 : remaining.indexOf(existing);
    if (idx !== -1) remaining.splice(idx, 1);
    else remaining.pop();
  }
  return remaining;
}

function emptyBuckets(): TierBuckets {
  return { 0: [], 1: [], 2: [], 3: [] };
}

async function buildPool(targetWeekStart: Date, excludeCurationIds: Set<number>): Promise<EligiblePool> {
  const cutoff = new Date(targetWeekStart);
  cutoff.setUTCDate(cutoff.getUTCDate() - REFEATURE_COOLDOWN_WEEKS * 7);

  const allSchedules = await CurationSchedule.findAll({
    attributes: ['curationId', 'weekStart'],
  });
  const everFeatured = new Set<number>();
  const recentlyFeatured = new Set<number>();
  for (const schedule of allSchedules) {
    everFeatured.add(schedule.curationId);
    if (schedule.weekStart >= cutoff) recentlyFeatured.add(schedule.curationId);
  }

  const curations = await Curation.findAll({
    include: [
      { model: CurationType, as: 'types', through: { attributes: [] } },
      {
        model: Level,
        as: 'level',
        attributes: ['id', 'isDeleted', 'isHidden'],
        required: true,
        where: { isDeleted: false, isHidden: false },
      },
    ],
  });

  const fresh = emptyBuckets();
  const refeature = emptyBuckets();
  const tierById = new Map<number, number>();

  for (const curation of curations) {
    const tier = scoreCuration(curation.types);
    if (tier === null) continue;
    tierById.set(curation.id, tier);

    if (excludeCurationIds.has(curation.id)) continue;
    if (recentlyFeatured.has(curation.id)) continue;

    if (everFeatured.has(curation.id)) refeature[tier].push(curation.id);
    else fresh[tier].push(curation.id);
  }

  for (const tier of ALL_TIERS) {
    shuffle(fresh[tier]);
    shuffle(refeature[tier]);
  }

  return { fresh, refeature, tierById };
}

function pickForHall(
  pool: EligiblePool,
  hall: ListType,
  existingTiers: (number | null)[],
  freeSlots: number,
): number[] {
  if (freeSlots <= 0) return [];
  const composition = hall === 'primary' ? PRIMARY_COMPOSITION : SECONDARY_COMPOSITION;
  const demand = buildTierDemand(composition, existingTiers);
  const picked: number[] = [];
  for (const demandedTier of demand) {
    if (picked.length >= freeSlots) break;
    const id = popForTier(pool, hall, demandedTier);
    if (id != null) picked.push(id);
  }
  return shuffle(picked);
}

export class WeeklyScheduleFillService {
  /**
   * Best-effort fill of the primary/secondary halls for a week. Cron mode is a
   * strict no-op when any row already exists for the week; manual mode only
   * appends toward {@link FILL_TARGET} and never removes existing rows.
   */
  static async fillWeek(args: FillWeekArgs): Promise<FillWeekResult> {
    const { halls, scheduledBy, mode } = args;
    const targetWeekStart = getWeekStartMonday(args.weekStart);
    const perHall: Record<ListType, number> = { primary: 0, secondary: 0 };

    const sequelize = CurationSchedule.sequelize;
    if (!sequelize) throw new Error('CurationSchedule sequelize instance unavailable');

    const transaction = await sequelize.transaction();
    try {
      const existing = await CurationSchedule.findAll({
        where: { weekStart: targetWeekStart },
        transaction,
      });

      if (mode === 'cron' && existing.length > 0) {
        await transaction.commit();
        return { skipped: true, reason: 'week-not-empty', weekStart: targetWeekStart, created: 0, perHall };
      }

      const inWeek = new Set<number>(existing.map((row) => row.curationId));
      const pool = await buildPool(targetWeekStart, inWeek);

      const targetHalls: ListType[] = halls === 'both' ? ['primary', 'secondary'] : [halls];
      const rowsToCreate: {
        curationId: number;
        weekStart: Date;
        listType: ListType;
        position: number;
        scheduledBy: string;
        isActive: boolean;
      }[] = [];

      for (const hall of targetHalls) {
        const hallRows = existing.filter((row) => row.listType === hall);
        const activeRows = hallRows.filter((row) => row.isActive);
        const activeCount = activeRows.length;
        if (activeCount >= FILL_TARGET) continue;

        const existingTiers = activeRows.map(
          (row) => pool.tierById.get(row.curationId) ?? null,
        );
        const nextPosition = hallRows.reduce((max, row) => Math.max(max, row.position + 1), 0);
        const freeByTarget = FILL_TARGET - activeCount;
        const freeBySlots = MAX_SLOTS - nextPosition;
        const freeSlots = Math.min(freeByTarget, freeBySlots);

        const ids = pickForHall(pool, hall, existingTiers, freeSlots);
        ids.forEach((curationId, index) => {
          rowsToCreate.push({
            curationId,
            weekStart: targetWeekStart,
            listType: hall,
            position: nextPosition + index,
            scheduledBy,
            isActive: true,
          });
        });
        perHall[hall] = ids.length;
      }

      if (rowsToCreate.length > 0) {
        await CurationSchedule.bulkCreate(rowsToCreate, { transaction });
      }

      await transaction.commit();

      const created = perHall.primary + perHall.secondary;
      logger.debug('[curation-schedule] Auto-fill complete', {
        weekStart: targetWeekStart.toISOString().split('T')[0],
        mode,
        halls,
        created,
        perHall,
      });

      return { skipped: false, weekStart: targetWeekStart, created, perHall };
    } catch (error) {
      await transaction.rollback().catch(() => undefined);
      logger.error('[curation-schedule] Auto-fill failed', error);
      throw error;
    }
  }
}

export default WeeklyScheduleFillService;
