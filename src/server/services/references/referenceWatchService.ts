import {Op} from 'sequelize';
import Difficulty from '@/models/levels/Difficulty.js';
import ReferenceWatch from '@/models/notifications/ReferenceWatch.js';
import {mapMysqlClientError} from '@/misc/utils/db/mysqlClientError.js';
import {
  isReferenceWatchGroup,
  isWatchablePguDifficultyName,
  type ReferenceWatchGroup,
} from './pguDifficulty.js';

export class ReferenceWatchError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ReferenceWatchError';
    this.status = status;
  }
}

export async function listWatchDifficultyIds(userId: string): Promise<number[]> {
  const rows = await ReferenceWatch.findAll({
    attributes: ['difficultyId'],
    where: {userId},
  });
  const ids: number[] = [];
  for (const row of rows) {
    const id = Number(row.difficultyId);
    if (Number.isInteger(id) && id > 0) ids.push(id);
  }
  return ids.sort((a, b) => a - b);
}

async function assertWatchableDifficulty(difficultyId: number): Promise<void> {
  const difficulty = await Difficulty.findByPk(difficultyId, {
    attributes: ['id', 'name', 'type'],
  });
  if (!difficulty || difficulty.type !== 'PGU' || !isWatchablePguDifficultyName(difficulty.name)) {
    throw new ReferenceWatchError('Difficulty is not a watchable PGU reference tier', 400);
  }
}

async function listGroupDifficultyIds(group: ReferenceWatchGroup): Promise<number[]> {
  const rows = await Difficulty.findAll({
    attributes: ['id', 'name'],
    where: {type: 'PGU'},
  });
  return rows
    .filter(
      (row) => isWatchablePguDifficultyName(row.name) && row.name.startsWith(group),
    )
    .map((row) => Number(row.id))
    .filter((id) => Number.isInteger(id) && id > 0);
}

export async function setDifficultyWatch(
  userId: string,
  difficultyId: number,
  watched: boolean,
): Promise<number[]> {
  if (!Number.isInteger(difficultyId) || difficultyId <= 0) {
    throw new ReferenceWatchError('Invalid difficulty id', 400);
  }
  await assertWatchableDifficulty(difficultyId);

  if (watched) {
    try {
      await ReferenceWatch.create({userId, difficultyId});
    } catch (err) {
      if (mapMysqlClientError(err)?.code !== 'ER_DUP_ENTRY') throw err;
    }
  } else {
    await ReferenceWatch.destroy({where: {userId, difficultyId}});
  }
  return listWatchDifficultyIds(userId);
}

export async function setGroupWatch(
  userId: string,
  group: string,
  watched: boolean,
): Promise<number[]> {
  if (!isReferenceWatchGroup(group)) {
    throw new ReferenceWatchError('group must be P, G, or U', 400);
  }
  const difficultyIds = await listGroupDifficultyIds(group);
  if (watched) {
    if (difficultyIds.length) {
      await ReferenceWatch.bulkCreate(
        difficultyIds.map((difficultyId) => ({userId, difficultyId})),
        {ignoreDuplicates: true},
      );
    }
  } else if (difficultyIds.length) {
    await ReferenceWatch.destroy({
      where: {userId, difficultyId: {[Op.in]: difficultyIds}},
    });
  }
  return listWatchDifficultyIds(userId);
}
