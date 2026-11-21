import { QueryTypes } from 'sequelize';
import { getSequelizeForModelGroup } from '@/config/db.js';
import { coerceJudgements } from '../engine/judgement.js';
import { definitionFromRow } from '../jobs/definitions.js';
import { toPublicBadge, type ProvingClear, type PublicBadge } from './publicShape.js';

type DefinitionRow = Parameters<typeof definitionFromRow>[0];

type StateRow = {
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
};

function db() {
  return getSequelizeForModelGroup('badges');
}

async function select<T>(sql: string, replacements?: Record<string, unknown>): Promise<T[]> {
  return db().query(sql, { replacements, type: QueryTypes.SELECT }) as Promise<T[]>;
}

function asIds(value: unknown): number[] {
  return Array.isArray(value) ? value.map((item) => Number(item)).filter((item) => Number.isInteger(item)) : [];
}

async function provingPasses(ids: number[]): Promise<ProvingClear[]> {
  if (!ids.length) return [];
  const rows = await select<{
    id: number;
    accuracy: number | null;
    speed: number | null;
    isWorldsFirst: number | null;
    isWorldsFirstPP: number | null;
    isXPerfectMode: number | null;
    levelId: number | null;
    song: string | null;
    artist: string | null;
    diffId: number | null;
    earlyDouble: number | null;
    earlySingle: number | null;
    ePerfect: number | null;
    perfectMinus: number | null;
    perfect: number | null;
    perfectPlus: number | null;
    lPerfect: number | null;
    lateSingle: number | null;
    lateDouble: number | null;
  }>(
    `SELECT p.id, p.accuracy, p.speed, p.isWorldsFirst, p.isWorldsFirstPP, p.isXPerfectMode,
      l.id AS levelId, l.song, l.artist, l.diffId,
      j.earlyDouble, j.earlySingle, j.ePerfect, j.perfectMinus, j.perfect, j.perfectPlus,
      j.lPerfect, j.lateSingle, j.lateDouble
     FROM passes p
     LEFT JOIN judgements j ON j.id = p.id
     LEFT JOIN levels l ON l.id = p.levelId
     WHERE p.id IN (:ids)`,
    { ids },
  );
  return rows.map((row) => ({
    id: Number(row.id),
    accuracy: row.accuracy == null ? null : Number(row.accuracy),
    speed: row.speed == null ? null : Number(row.speed),
    isWorldsFirst: Boolean(row.isWorldsFirst),
    isWorldsFirstPP: Boolean(row.isWorldsFirstPP),
    isXPerfectMode: Boolean(row.isXPerfectMode),
    judgements: coerceJudgements({
      earlyDouble: Number(row.earlyDouble ?? 0),
      earlySingle: Number(row.earlySingle ?? 0),
      ePerfect: Number(row.ePerfect ?? 0),
      perfectMinus: Number(row.perfectMinus ?? 0),
      perfect: Number(row.perfect ?? 0),
      perfectPlus: Number(row.perfectPlus ?? 0),
      lPerfect: Number(row.lPerfect ?? 0),
      lateSingle: Number(row.lateSingle ?? 0),
      lateDouble: Number(row.lateDouble ?? 0),
    }),
    level: row.levelId
      ? {
          id: Number(row.levelId),
          song: row.song || '',
          artist: row.artist || '',
          diffId: Number(row.diffId) || 0,
        }
      : null,
  }));
}

type DefinitionSqlRow = DefinitionRow & {
  groupId: number | null;
  sortOrder: number;
  groupName: string | null;
  groupSortOrder: number | null;
};

function placementFromRow(row: DefinitionSqlRow) {
  return {
    groupId: row.groupId == null ? null : Number(row.groupId) || null,
    groupName: typeof row.groupName === 'string' ? row.groupName : null,
    groupSortOrder: row.groupSortOrder == null ? null : Number(row.groupSortOrder),
    sortOrder: Number(row.sortOrder) || 0,
  };
}

export async function readOwnerBadges(audience: 'player' | 'creator', ownerId: number, canEquip: boolean) {
  const definitionRows = await select<DefinitionSqlRow>(
    `SELECT
      d.*,
      g.name AS groupName,
      g.sortOrder AS groupSortOrder
    FROM badge_definitions d
    LEFT JOIN badge_groups g ON g.id = d.groupId
    WHERE d.audience = :audience AND d.enabled = 1
    ORDER BY
      CASE WHEN d.groupId IS NULL THEN 1 ELSE 0 END ASC,
      g.sortOrder ASC,
      g.name ASC,
      d.sortOrder ASC,
      d.name ASC`,
    { audience },
  );
  const definitions = definitionRows
    .map((row) => {
      const def = definitionFromRow(row);
      return def ? { def, placement: placementFromRow(row) } : null;
    })
    .filter((row): row is { def: NonNullable<ReturnType<typeof definitionFromRow>>; placement: ReturnType<typeof placementFromRow> } => row != null);
  const states = await select<StateRow>(
    'SELECT * FROM badge_states WHERE ownerType = :audience AND ownerId = :ownerId',
    { audience, ownerId },
  );
  const equips = await select<{ slot: number; definitionId: number }>(
    'SELECT slot, definitionId FROM badge_equips WHERE ownerType = :audience AND ownerId = :ownerId ORDER BY slot ASC',
    { audience, ownerId },
  );
  const stateById = new Map(states.map((row) => [Number(row.definitionId), row]));
  const confirmIds = new Set(definitions.filter((row) => row.def.confirm !== 'none' && row.def.id).map((row) => row.def.id as number));
  const provingIds = [...new Set(
    states
      .filter((row) => confirmIds.has(Number(row.definitionId)))
      .flatMap((row) => asIds(row.provingPassIds).slice(0, 100)),
  )];
  const passes = await provingPasses(provingIds);
  const badges: PublicBadge[] = [];
  for (const { def, placement } of definitions) {
    const row = def.id ? stateById.get(def.id) : undefined;
    const state = row
      ? {
          tier: Number(row.tier) || 0,
          credit: Number(row.credit) || 0,
          barFrom: Number(row.barFrom) || 0,
          barTo: Number(row.barTo) || 0,
          barValue: Number(row.barValue) || 0,
          provingPassIds: asIds(row.provingPassIds),
          earnedAt: row.earnedAt ? new Date(row.earnedAt).toISOString() : null,
          tierLabel: row.tierLabel,
          snapshotIds: asIds(row.snapshotIds),
        }
      : null;
    const view = toPublicBadge(
      def,
      state,
      passes.filter((pass) => state?.provingPassIds.includes(pass.id)),
      placement,
    );
    if (view) badges.push(view);
  }
  const earned = new Set(badges.filter((badge) => badge.earned).map((badge) => badge.id));
  return {
    canEquip,
    equippedIds: equips.map((row) => Number(row.definitionId)).filter((id) => earned.has(id)).slice(0, 5),
    badges,
  };
}

export async function saveOwnerEquips(
  audience: 'player' | 'creator',
  ownerId: number,
  badgeIds: number[],
): Promise<void> {
  const unique: number[] = [];
  for (const id of badgeIds) {
    if (!Number.isInteger(id) || unique.includes(id)) continue;
    unique.push(id);
    if (unique.length >= 5) break;
  }
  const states = await select<{ definitionId: number; tier: number }>(
    `SELECT definitionId, tier FROM badge_states
     WHERE ownerType = :audience AND ownerId = :ownerId AND tier > 0`,
    { audience, ownerId },
  );
  const earned = new Set(states.map((row) => Number(row.definitionId)));
  if (unique.some((id) => !earned.has(id))) {
    throw new Error('Only earned badges can be equipped');
  }
  await db().transaction(async (transaction) => {
    await db().query(
      'DELETE FROM badge_equips WHERE ownerType = :audience AND ownerId = :ownerId',
      { replacements: { audience, ownerId }, transaction },
    );
    for (let index = 0; index < unique.length; index += 1) {
      await db().query(
        `INSERT INTO badge_equips (ownerType, ownerId, slot, definitionId, createdAt, updatedAt)
         VALUES (:audience, :ownerId, :slot, :definitionId, NOW(), NOW())`,
        { replacements: { audience, ownerId, slot: index + 1, definitionId: unique[index] }, transaction },
      );
    }
  });
}
