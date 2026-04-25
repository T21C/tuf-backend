import { Op } from 'sequelize';
import Creator from '@/models/credits/Creator.js';
import { CreatorAlias } from '@/models/credits/CreatorAlias.js';
import User from '@/models/auth/User.js';
import {
  runCreatorStatsQuery,
  CreatorStatsRow,
} from '@/server/services/elasticsearch/misc/creatorStatsQuery.js';
import { buildCreatorIndexDocument } from '@/server/services/elasticsearch/indexing/creatorIndexDocument.js';
import { logger } from '@/server/services/core/LoggerService.js';

export interface PreparedCreatorDocument {
  id: number;
  document: Record<string, unknown>;
}

/**
 * Load everything needed to rebuild N creator ES documents in bulk, then build them.
 */
export async function fetchCreatorsForBulkIndex(creatorIds: number[]): Promise<PreparedCreatorDocument[]> {
  if (creatorIds.length === 0) return [];

  const ids = [...new Set(creatorIds)].filter((id) => Number.isFinite(id) && id > 0);
  if (ids.length === 0) return [];

  const [creators, aliases, users, statsRows] = await Promise.all([
    Creator.findAll({
      where: { id: { [Op.in]: ids } },
    }),
    CreatorAlias.findAll({
      where: { creatorId: { [Op.in]: ids } },
    }),
    User.findAll({
      where: { creatorId: { [Op.in]: ids } },
    }),
    runCreatorStatsQuery({ creatorIds: ids }),
  ]);

  const aliasesByCreatorId = new Map<number, CreatorAlias[]>();
  for (const alias of aliases) {
    const list = aliasesByCreatorId.get(alias.creatorId) ?? [];
    list.push(alias);
    aliasesByCreatorId.set(alias.creatorId, list);
  }

  const userByCreatorId = new Map<number, User>();
  for (const u of users) {
    if (u.creatorId != null) userByCreatorId.set(u.creatorId, u);
  }

  const statsById = new Map<number, CreatorStatsRow>();
  for (const row of statsRows) {
    statsById.set(Number(row.id), row);
  }

  const out: PreparedCreatorDocument[] = [];
  for (const creator of creators) {
    try {
      const user = userByCreatorId.get(creator.id) ?? null;
      const creatorAliases = aliasesByCreatorId.get(creator.id) ?? [];
      const stats = statsById.get(creator.id) ?? null;

      const doc = buildCreatorIndexDocument({
        creator,
        user,
        aliases: creatorAliases,
        stats,
      });
      out.push({ id: creator.id, document: doc });
    } catch (error) {
      logger.error(`Failed to build creator document for creator ${creator.id}:`, error);
    }
  }

  return out;
}

export async function fetchCreatorDocument(creatorId: number): Promise<PreparedCreatorDocument | null> {
  const docs = await fetchCreatorsForBulkIndex([creatorId]);
  return docs[0] ?? null;
}
