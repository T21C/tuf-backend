import Pass from '@/models/passes/Pass.js';
import { Op } from 'sequelize';
import Judgement from '@/models/passes/Judgement.js';
import Player from '@/models/players/Player.js';
import User from '@/models/auth/User.js';
import Level from '@/models/levels/Level.js';
import Difficulty from '@/models/levels/Difficulty.js';
import LevelAlias from '@/models/levels/LevelAlias.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import Creator from '@/models/credits/Creator.js';
import { CreatorAlias } from '@/models/credits/CreatorAlias.js';
import Team from '@/models/credits/Team.js';

/** Reuse Player/Level rows across reindex batches. */
const esPlayerCache = new Map<number, any>();
const esLevelCache = new Map<number, any>();

/** Drop cached level rows so pass reindex picks up fresh diffId / metadata. */
export function invalidateEsLevelCacheForLevelIds(levelIds: Iterable<number>): void {
  for (const levelId of levelIds) {
    if (Number.isFinite(levelId) && levelId > 0) {
      esLevelCache.delete(levelId);
    }
  }
}

export function clearEsPassIndexRelationCaches(): void {
  esPlayerCache.clear();
  esLevelCache.clear();
}

function groupById<T extends { id: number }>(rows: T[]): Map<number, T> {
  const m = new Map<number, T>();
  for (const r of rows) m.set(r.id, r);
  return m;
}

function groupLevelCreditsByLevelId(rows: LevelCredit[]): Map<number, LevelCredit[]> {
  const m = new Map<number, LevelCredit[]>();
  for (const r of rows) {
    const arr = m.get(r.levelId) ?? [];
    arr.push(r);
    m.set(r.levelId, arr);
  }
  return m;
}

async function cacheLevelsForPassIndex(levelIds: number[]): Promise<void> {
  if (levelIds.length === 0) return;

  const levels = await Level.findAll({
    where: { id: { [Op.in]: levelIds } },
    include: [
      { model: Difficulty, as: 'difficulty', attributes: ['id', 'name', 'type', 'icon', 'color', 'emoji', 'sortOrder'] },
      { model: LevelAlias, as: 'aliases', attributes: ['id', 'levelId', 'field', 'originalValue', 'alias', 'createdAt', 'updatedAt'] },
      { model: Team, as: 'teamObject', attributes: ['id', 'name'] },
    ],
  });

  const levelCredits = await LevelCredit.findAll({
    where: { levelId: { [Op.in]: levelIds } },
    attributes: ['levelId', 'creatorId', 'role', 'isOwner', 'sortOrder'],
    order: [
      ['levelId', 'ASC'],
      ['sortOrder', 'ASC'],
    ],
    include: [
      {
        model: Creator,
        as: 'creator',
        attributes: ['id', 'name'],
        include: [{ model: CreatorAlias, as: 'creatorAliases', attributes: ['name'] }],
      },
    ],
  });

  const creditsByLevel = groupLevelCreditsByLevelId(levelCredits);

  for (const level of levels) {
    const lv = level as unknown as Level & { setDataValue: (k: string, v: unknown) => void };
    lv.setDataValue('levelCredits', creditsByLevel.get(level.id) ?? []);
    esLevelCache.set(level.id, lv.get({ plain: true }));
  }
}

export async function fetchPassesForBulkIndex(passIds: number[]): Promise<Pass[]> {
  if (passIds.length === 0) return [];
  const ids = [...new Set(passIds)]
    .map(Number)
    .filter((id) => Number.isFinite(id) && id > 0)
    .sort((a, b) => a - b);
  if (ids.length === 0) return [];

  const passes = await Pass.findAll({
    where: { id: { [Op.in]: ids } },
    order: [['id', 'ASC']],
  });

  const playerIds = [...new Set(passes.map((p) => p.playerId).filter((v): v is number => v != null))];
  const levelIds = [...new Set(passes.map((p) => p.levelId).filter((v): v is number => v != null))];

  const missingPlayerIds = playerIds.filter((id) => !esPlayerCache.has(id));
  if (missingPlayerIds.length) {
    const players = await Player.findAll({
      where: { id: { [Op.in]: missingPlayerIds } },
      attributes: ['id', 'name', 'country', 'isBanned'],
      include: [{ model: User, as: 'user', attributes: ['avatarUrl', 'username'] }],
    });
    for (const p of players) esPlayerCache.set(p.id, p.get({ plain: true }));
  }

  const missingLevelIds = levelIds.filter((id) => !esLevelCache.has(id));
  if (missingLevelIds.length) {
    await cacheLevelsForPassIndex(missingLevelIds);
  }

  const judgements = await Judgement.findAll({
    where: { id: { [Op.in]: ids } },
  });
  const judgementByPassId = groupById(judgements);

  const pv = passes as unknown as Array<Pass & { setDataValue: (k: string, v: unknown) => void }>;
  for (const pass of pv) {
    pass.setDataValue('player', esPlayerCache.get(pass.playerId) ?? null);
    pass.setDataValue('level', esLevelCache.get(pass.levelId) ?? null);
    pass.setDataValue('judgements', judgementByPassId.get(pass.id) ?? null);
  }

  return passes;
}



export async function fetchPassWithRelations(passId: number): Promise<Pass | null> {
  const passes = await fetchPassesForBulkIndex([passId]);
  return passes[0] ?? null;
}
