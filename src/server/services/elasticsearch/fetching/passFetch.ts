import Pass from '@/models/passes/Pass.js';
import { Op } from 'sequelize';
import Judgement from '@/models/passes/Judgement.js';
import Player from '@/models/players/Player.js';
import User from '@/models/auth/User.js';
import Level from '@/models/levels/Level.js';
import Difficulty from '@/models/levels/Difficulty.js';
import LevelAlias from '@/models/levels/LevelAlias.js';

/** Reuse Player/Level rows across reindex batches. */
const esPlayerCache = new Map<number, any>();
const esLevelCache = new Map<number, any>();

export function clearEsPassIndexRelationCaches(): void {
  esPlayerCache.clear();
  esLevelCache.clear();
}

function groupById<T extends { id: number }>(rows: T[]): Map<number, T> {
  const m = new Map<number, T>();
  for (const r of rows) m.set(r.id, r);
  return m;
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
    const levels = await Level.findAll({
      where: { id: { [Op.in]: missingLevelIds } },
      include: [
        { model: Difficulty, as: 'difficulty', attributes: ['id', 'name', 'type', 'icon', 'color', 'emoji', 'sortOrder'] },
        { model: LevelAlias, as: 'aliases', attributes: ['id', 'levelId', 'field', 'originalValue', 'alias', 'createdAt', 'updatedAt'] },
      ],
    });
    for (const l of levels) esLevelCache.set(l.id, l.get({ plain: true }));
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
