import { logger } from '@/server/services/core/LoggerService.js';
import Level from '@/models/levels/Level.js';
import { fetchLevelsForBulkIndex } from '@/server/services/elasticsearch/levelBulkFetch.js';

export async function fetchLevelWithRelations(levelId: number): Promise<Level | null> {
  logger.debug(`Getting level with relations (bulk-backed) for level ${levelId}`);
  const levels = await fetchLevelsForBulkIndex([levelId]);
  return levels[0] ?? null;
}
