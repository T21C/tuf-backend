import type {Transaction} from 'sequelize';
import Curation from '@/models/curations/Curation.js';
import CurationType from '@/models/curations/CurationType.js';
import Level from '@/models/levels/Level.js';
import {recordCurationTypeChange} from '@/server/domain/curations/recordCurationTypeHistory.js';
import type {CurationRatingPicks} from '@/misc/utils/data/curationRatingPicks.js';
import {collectedTypeIds} from '@/misc/utils/data/curationRatingPicks.js';

export async function replaceLevelCurationTypes(
  levelId: number,
  picks: CurationRatingPicks,
  assignedBy: string,
  transaction: Transaction,
): Promise<{previousTypeIds: number[]; typeIds: number[]}> {
  const typeIds = collectedTypeIds(picks);
  const existingRow = await Curation.findOne({
    where: {levelId},
    include: [{model: CurationType, as: 'types', through: {attributes: []}}],
    transaction,
  });
  const previousTypeIds = (existingRow?.types || []).map((type) => type.id);

  await Curation.upsert(
    {
      levelId,
      assignedBy,
      shortDescription: existingRow?.shortDescription ?? '',
      description: existingRow?.description ?? null,
      customCSS: existingRow?.customCSS ?? null,
      customColor: existingRow?.customColor ?? null,
      isDuplicate: existingRow?.isDuplicate ?? false,
    },
    {transaction},
  );
  const row = await Curation.findOne({where: {levelId}, transaction});
  if (!row) {
    throw new Error('Failed to load curation after settle');
  }
  await row.setTypes(typeIds, {transaction});
  await recordCurationTypeChange({
    levelId,
    previousTypeIds,
    newTypeIds: typeIds,
    changedBy: assignedBy,
    transaction,
  });
  return {previousTypeIds, typeIds};
}

export async function closeCurationQueue(
  levelId: number,
  transaction: Transaction,
): Promise<void> {
  await Level.update(
    {toCuration: false, curationFlow: null},
    {where: {id: levelId}, transaction},
  );
}
