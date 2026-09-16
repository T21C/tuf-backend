import Pass from '@/models/passes/Pass.js';

export async function updateWorldsFirstStatus(
  levelId: number,
  transaction?: any,
) : Promise<Pass | null> {
  // Find the earliest non-deleted pass for this level from non-banned players
  const earliestPass = await Pass.findOne({
    where: {
      levelId,
      isDeleted: false
    },
    attributes: ['id', 'vidUploadTime'],
    order: [['vidUploadTime', 'ASC']],
    transaction,
  });

  // Reset all passes for this level to not be world's first
  await Pass.update(
    {isWorldsFirst: false},
    {
      where: {levelId, isWorldsFirst: true},
      transaction,
    },
  );

  // If we found an earliest pass, mark it as world's first
  if (earliestPass) {
    await Pass.update(
      {isWorldsFirst: true},
      {
        where: {id: earliestPass.id},
        transaction,
      },
    );
    return earliestPass!;
  }
  return null;
}

export async function updateWorldsFirstPPStatus(
  levelId: number,
  transaction?: any,
): Promise<Pass | null> {
  const earliestPP = await Pass.findOne({
    where: {
      levelId,
      isDeleted: false,
      accuracy: 1,
    },
    attributes: ['id', 'vidUploadTime'],
    order: [['vidUploadTime', 'ASC']],
    transaction,
  });

  await Pass.update(
    {isWorldsFirstPP: false},
    {
      where: {levelId, isWorldsFirstPP: true},
      transaction,
    },
  );

  if (earliestPP) {
    await Pass.update(
      {isWorldsFirstPP: true},
      {
        where: {id: earliestPP.id},
        transaction,
      },
    );
    return earliestPP;
  }
  return null;
}

export async function updateWorldsFirstFlags(
  levelId: number,
  transaction?: any,
): Promise<void> {
  await updateWorldsFirstStatus(levelId, transaction);
  await updateWorldsFirstPPStatus(levelId, transaction);
}
