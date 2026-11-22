import Pass from '@/models/passes/Pass.js';
import { logBadgeFailure, signalBadgeDirt, snapshotMissingPasses } from '@/server/services/badges/index.js';

/** Only 1.0x clears qualify for world's first and world's first PP. */
const WORLDS_FIRST_SPEED = 1;

export async function updateWorldsFirstStatus(
  levelId: number,
  transaction?: any,
) : Promise<Pass | null> {
  // Earliest non-deleted 1.0x pass for this level
  const earliestPass = await Pass.findOne({
    where: {
      levelId,
      isDeleted: false,
      speed: WORLDS_FIRST_SPEED,
    },
    attributes: ['id', 'playerId', 'vidUploadTime'],
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
  playerId?: number,
): Promise<Pass | null> {
  const earliestPP = await Pass.findOne({
    where: {
      levelId,
      isDeleted: false,
      accuracy: 1,
      speed: WORLDS_FIRST_SPEED,
    },
    attributes: ['id', 'playerId', 'vidUploadTime'],
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
    await touchBadgeLevel(levelId, transaction, [playerId, Number(earliestPP.playerId)]);
    return earliestPP;
  }
  await touchBadgeLevel(levelId, transaction, [playerId]);
  return null;
}

async function touchBadgeLevel(levelId: number, transaction?: any, playerIds: Array<number | null | undefined> = []): Promise<void> {
  try {
    await snapshotMissingPasses(levelId, transaction);
  } catch (error) {
    logBadgeFailure('snapshot', error);
  }
  signalBadgeDirt({
    levels: [levelId],
    players: playerIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0),
  }, transaction);
}

export async function updateWorldsFirstFlags(
  levelId: number,
  transaction?: any,
  playerId?: number,
): Promise<void> {
  const earliest = await updateWorldsFirstStatus(levelId, transaction);
  const fromWorldsFirst = Number(earliest?.playerId);
  await updateWorldsFirstPPStatus(
    levelId,
    transaction,
    playerId ?? (Number.isInteger(fromWorldsFirst) && fromWorldsFirst > 0 ? fromWorldsFirst : undefined),
  );
}
