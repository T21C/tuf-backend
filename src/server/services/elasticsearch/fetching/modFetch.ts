import {Op} from 'sequelize';
import Mod from '@/models/misc/Mod.js';
import {serializeMods} from '@/server/services/mods/serializeMod.js';
import {buildModIndexDocument} from '@/server/services/elasticsearch/indexing/modIndexDocument.js';

export type PreparedModDocument = {
  id: number;
  document: ReturnType<typeof buildModIndexDocument>;
};

export async function fetchModsForBulkIndex(modIds: number[]): Promise<PreparedModDocument[]> {
  const ids = [...new Set(modIds)].filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) return [];

  const mods = await Mod.findAll({
    where: {id: {[Op.in]: ids}},
  });
  const serialized = await serializeMods(mods, {includeHidden: true});
  return serialized.map((mod) => ({
    id: mod.id,
    document: buildModIndexDocument(mod),
  }));
}
