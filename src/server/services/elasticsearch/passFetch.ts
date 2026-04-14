import Pass from '@/models/passes/Pass.js';
import { fetchPassesForBulkIndex } from '@/server/services/elasticsearch/passBulkFetch.js';

export async function fetchPassWithRelations(passId: number): Promise<Pass | null> {
  const passes = await fetchPassesForBulkIndex([passId]);
  return passes[0] ?? null;
}
