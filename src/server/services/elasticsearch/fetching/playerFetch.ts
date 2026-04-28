import { Op } from 'sequelize';
import Player from '@/models/players/Player.js';
import User from '@/models/auth/User.js';
import Creator from '@/models/credits/Creator.js';
import OAuthProvider from '@/models/auth/OAuthProvider.js';
import Difficulty from '@/models/levels/Difficulty.js';
import { runPlayerStatsQuery, PlayerStatsRow } from '@/server/services/elasticsearch/misc/playerStatsQuery.js';
import { buildPlayerIndexDocument } from '@/server/services/elasticsearch/indexing/playerIndexDocument.js';
import { logger } from '@/server/services/core/LoggerService.js';

export interface PreparedPlayerDocument {
  id: number;
  document: Record<string, unknown>;
}

/**
 * Load everything needed to rebuild N player ES documents in bulk, then build them.
 */
export async function fetchPlayersForBulkIndex(playerIds: number[]): Promise<PreparedPlayerDocument[]> {
  if (playerIds.length === 0) return [];

  const ids = [...new Set(playerIds)].filter((id) => Number.isFinite(id) && id > 0);
  if (ids.length === 0) return [];

  const [players, users, statsRows] = await Promise.all([
    Player.findAll({
      where: { id: { [Op.in]: ids } },
    }),
    User.findAll({
      where: { playerId: { [Op.in]: ids } },
      include: [{ model: Creator, as: 'creator', required: false }],
    }),
    runPlayerStatsQuery({ playerIds: ids }),
  ]);

  const usersByPlayerId = new Map<number, User>();
  for (const u of users) {
    if (u.playerId != null) usersByPlayerId.set(u.playerId, u);
  }

  const userIds = users.map((u) => u.id).filter(Boolean);
  const discordProviders = userIds.length
    ? await OAuthProvider.findAll({
        where: {
          userId: { [Op.in]: userIds },
          provider: 'discord',
        },
        attributes: ['userId', 'providerId'],
      })
    : [];
  const discordByUserId = new Map<string, OAuthProvider>();
  for (const prov of discordProviders) {
    discordByUserId.set(prov.userId, prov);
  }

  const statsById = new Map<number, PlayerStatsRow>();
  for (const row of statsRows) {
    statsById.set(Number(row.id), row);
  }

  const diffIds = new Set<number>();
  for (const row of statsRows) {
    if (row.topDiffId) diffIds.add(Number(row.topDiffId));
    if (row.top12kDiffId) diffIds.add(Number(row.top12kDiffId));
  }

  const diffsArr =
    diffIds.size > 0
      ? await Difficulty.findAll({ where: { id: { [Op.in]: Array.from(diffIds) } } })
      : [];
  const diffsById = new Map<number, Difficulty>();
  for (const d of diffsArr) diffsById.set(d.id, d);

  const out: PreparedPlayerDocument[] = [];
  for (const player of players) {
    try {
      const user = usersByPlayerId.get(player.id) ?? null;
      const discord = user ? discordByUserId.get(user.id) ?? null : null;
      const stats = statsById.get(player.id) ?? null;
      const topDiff = stats?.topDiffId ? diffsById.get(Number(stats.topDiffId)) ?? null : null;
      const top12kDiff = stats?.top12kDiffId ? diffsById.get(Number(stats.top12kDiffId)) ?? null : null;

      const doc = buildPlayerIndexDocument({
        player,
        user,
        discordProvider: discord,
        topDiff,
        top12kDiff,
        stats,
      });
      out.push({ id: player.id, document: doc });
    } catch (error) {
      logger.error(`Failed to build player document for player ${player.id}:`, error);
    }
  }

  return out;
}


export async function fetchPlayerDocument(playerId: number): Promise<PreparedPlayerDocument | null> {
  const docs = await fetchPlayersForBulkIndex([playerId]);
  return docs[0] ?? null;
}
