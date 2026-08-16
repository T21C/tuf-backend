import type {Transaction} from 'sequelize';
import {Op} from 'sequelize';
import User from '@/models/auth/User.js';
import LevelCredit, {CreditRole} from '@/models/levels/LevelCredit.js';

export interface NotificationRecipients {
  userIds?: string[];
  playerIds?: number[];
  levelId?: number;
  creatorIds?: number[];
}

function addUserIds(ids: Set<string>, userIds?: string[]): void {
  for (const userId of userIds ?? []) {
    if (typeof userId === 'string' && userId.trim()) ids.add(userId);
  }
}

async function creatorIdsForLevel(
  levelId: number,
  transaction?: Transaction,
): Promise<number[]> {
  const credits = await LevelCredit.findAll({
    attributes: ['creatorId', 'isOwner', 'role'],
    where: {levelId},
    transaction,
  });
  if (!credits.length) return [];

  const owners = credits.filter((credit) => credit.isOwner);
  const selected = owners.length
    ? owners
    : credits.filter((credit) => credit.role?.toLowerCase() === CreditRole.CHARTER);

  return [...new Set(selected.map((credit) => credit.creatorId).filter((id) => Number.isFinite(id)))];
}

async function userIdsForCreatorIds(
  creatorIds: number[],
  transaction?: Transaction,
): Promise<string[]> {
  const unique = [...new Set(creatorIds.filter((id) => Number.isFinite(id) && id > 0))];
  if (!unique.length) return [];

  const users = await User.findAll({
    attributes: ['id'],
    where: {creatorId: {[Op.in]: unique}},
    transaction,
  });
  return users.map((user) => user.id);
}

export async function resolveRecipientUserIds(
  recipients: NotificationRecipients,
  transaction?: Transaction,
): Promise<string[]> {
  const ids = new Set<string>();
  addUserIds(ids, recipients.userIds);

  const playerIds = [...new Set((recipients.playerIds ?? []).filter((id) => Number.isFinite(id)))];
  if (playerIds.length) {
    const users = await User.findAll({
      attributes: ['id'],
      where: {playerId: {[Op.in]: playerIds}},
      transaction,
    });
    for (const user of users) ids.add(user.id);
  }

  const creatorIds = [...(recipients.creatorIds ?? [])];
  if (typeof recipients.levelId === 'number' && Number.isFinite(recipients.levelId)) {
    creatorIds.push(...(await creatorIdsForLevel(recipients.levelId, transaction)));
  }
  for (const userId of await userIdsForCreatorIds(creatorIds, transaction)) {
    ids.add(userId);
  }

  return [...ids];
}
