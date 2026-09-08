import {Op} from 'sequelize';
import Pass from '@/models/passes/Pass.js';
import Level from '@/models/levels/Level.js';
import Player from '@/models/players/Player.js';
import PlayerStats from '@/models/players/PlayerStats.js';
import User from '@/models/auth/User.js';
import Judgement from '@/models/passes/Judgement.js';
import LevelPack from '@/models/packs/LevelPack.js';
import Difficulty from '@/models/levels/Difficulty.js';
import type {FavoriteItem, FavoriteItemKind} from '@/misc/utils/profileModules/index.js';
import {
  isFavoriteLevelHidden,
  isFavoritePackHidden,
  isFavoritePassHidden,
  isFavoritePlayerHidden,
} from '@/misc/utils/profileModules/index.js';

export type HydratedFavoriteItem = {
  kind: FavoriteItemKind;
  id: number;
  pass?: Record<string, unknown>;
  level?: Record<string, unknown>;
  pack?: Record<string, unknown>;
  player?: Record<string, unknown>;
};

function plain(row: {get?: (opts: {plain: boolean}) => unknown} | Record<string, unknown> | null): Record<string, unknown> | null {
  if (!row) return null;
  if (typeof (row as {get?: unknown}).get === 'function') {
    return (row as {get: (opts: {plain: boolean}) => Record<string, unknown>}).get({plain: true});
  }
  return row as Record<string, unknown>;
}

function idsOfKind(items: FavoriteItem[], kind: FavoriteItemKind): number[] {
  return [...new Set(items.filter((item) => item.kind === kind).map((item) => item.id))];
}

export async function hydrateFavoriteItems(items: FavoriteItem[]): Promise<HydratedFavoriteItem[]> {
  if (!items.length) return [];

  const passIds = idsOfKind(items, 'pass');
  const levelIds = idsOfKind(items, 'level');
  const packIds = idsOfKind(items, 'pack');
  const playerIds = idsOfKind(items, 'player');

  const [passes, levels, packs, players] = await Promise.all([
    passIds.length
      ? Pass.findAll({
          where: {id: {[Op.in]: passIds}},
          include: [
            {
              model: Level,
              as: 'level',
              attributes: [
                'id',
                'song',
                'artist',
                'diffId',
                'isHidden',
                'isDeleted',
                'videoLink',
                'baseScore',
              ],
              include: [{model: Difficulty, as: 'difficulty', required: false}],
            },
            {
              model: Player,
              as: 'player',
              attributes: ['id', 'name', 'country', 'pfp', 'isBanned'],
              include: [
                {
                  model: User,
                  as: 'user',
                  attributes: ['id', 'username', 'nickname', 'avatarUrl', 'avatarIsGif'],
                  required: false,
                },
              ],
            },
            {model: Judgement, as: 'judgements', required: false},
          ],
        })
      : Promise.resolve([]),
    levelIds.length
      ? Level.findAll({
          where: {id: {[Op.in]: levelIds}},
          attributes: [
            'id',
            'song',
            'artist',
            'diffId',
            'isHidden',
            'isDeleted',
            'videoLink',
            'baseScore',
            'clears',
            'likes',
            'downloadCount',
          ],
          include: [{model: Difficulty, as: 'difficulty', required: false}],
        })
      : Promise.resolve([]),
    packIds.length
      ? LevelPack.findAll({
          where: {id: {[Op.in]: packIds}},
          attributes: [
            'id',
            'ownerId',
            'name',
            'iconUrl',
            'viewMode',
            'isPinned',
            'favoritesCount',
            'levelCount',
          ],
          include: [
            {
              model: User,
              as: 'packOwner',
              attributes: ['id', 'username', 'nickname', 'avatarUrl', 'avatarIsGif'],
              required: false,
            },
          ],
        })
      : Promise.resolve([]),
    playerIds.length
      ? Player.findAll({
          where: {id: {[Op.in]: playerIds}},
          attributes: ['id', 'name', 'country', 'pfp', 'isBanned'],
          include: [
            {
              model: User,
              as: 'user',
              attributes: ['id', 'username', 'nickname', 'avatarUrl', 'avatarIsGif'],
              required: false,
            },
            {
              model: PlayerStats,
              as: 'stats',
              required: false,
            },
          ],
        })
      : Promise.resolve([]),
  ]);

  const passById = new Map<number, Record<string, unknown>>();
  for (const row of passes) {
    const data = plain(row);
    if (!data || isFavoritePassHidden(data as never)) continue;
    passById.set(Number(data.id), data);
  }

  const levelById = new Map<number, Record<string, unknown>>();
  for (const row of levels) {
    const data = plain(row);
    if (!data || isFavoriteLevelHidden(data as never)) continue;
    levelById.set(Number(data.id), data);
  }

  const packById = new Map<number, Record<string, unknown>>();
  for (const row of packs) {
    const data = plain(row);
    if (!data || isFavoritePackHidden(data as never)) continue;
    packById.set(Number(data.id), {
      ...data,
      // Public pack payloads use linkCode as `id` (see GET /packs).
      id: data.linkCode ?? data.id,
      packId: data.id,
      totalLevelCount: data.levelCount ?? 0,
      packItems: Array.isArray(data.packItems) ? data.packItems : [],
    });
  }

  const playerById = new Map<number, Record<string, unknown>>();
  for (const row of players) {
    const data = plain(row);
    if (!data || isFavoritePlayerHidden(data as never)) continue;
    const stats = (data.stats && typeof data.stats === 'object' ? data.stats : {}) as Record<
      string,
      unknown
    >;
    playerById.set(Number(data.id), {
      ...data,
      rankedScore: stats.rankedScore ?? 0,
      rankedScoreRank: stats.rankedScoreRank ?? 0,
      rank: stats.rankedScoreRank ?? 0,
      generalScore: stats.generalScore ?? 0,
      totalScoreV2: stats.totalScoreV2 ?? 0,
      averageXacc: stats.averageXacc ?? 0,
      ppScore: stats.ppScore ?? 0,
    });
  }

  const out: HydratedFavoriteItem[] = [];
  for (const item of items) {
    if (item.kind === 'pass') {
      const pass = passById.get(item.id);
      if (!pass) continue;
      out.push({kind: 'pass', id: item.id, pass});
    } else if (item.kind === 'level') {
      const level = levelById.get(item.id);
      if (!level) continue;
      out.push({kind: 'level', id: item.id, level});
    } else if (item.kind === 'pack') {
      const pack = packById.get(item.id);
      if (!pack) continue;
      out.push({kind: 'pack', id: item.id, pack});
    } else {
      const player = playerById.get(item.id);
      if (!player) continue;
      out.push({kind: 'player', id: item.id, player});
    }
  }
  return out;
}
