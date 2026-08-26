import type {Transaction} from 'sequelize';
import {Op} from 'sequelize';
import User from '@/models/auth/User.js';
import LevelCredit, {CreditRole} from '@/models/levels/LevelCredit.js';

export const CHART_CLEARED_CREDIT_ROLES = [CreditRole.CHARTER, CreditRole.VFXER] as const;

export interface NotificationRecipients {
  userIds?: string[];
  playerIds?: number[];
  levelId?: number;
  /** When set with levelId, notify users credited in these roles instead of owner/charter fallback. */
  levelCreditRoles?: string[];
  creatorIds?: number[];
}

export interface CreditLike {
  creatorId: number;
  isOwner: boolean;
  role?: string | null;
}

function addUserIds(ids: Set<string>, userIds?: string[]): void {
  for (const userId of userIds ?? []) {
    if (typeof userId === 'string' && userId.trim()) ids.add(userId);
  }
}

export function selectCreatorIdsForNotification(
  credits: CreditLike[],
  roles?: string[],
): number[] {
  if (!credits.length) return [];

  const wanted = roles?.length
    ? new Set(roles.map((role) => role.toLowerCase()))
    : null;
  const selected = wanted
    ? credits.filter((credit) => wanted.has((credit.role ?? '').toLowerCase()))
    : (() => {
        const owners = credits.filter((credit) => credit.isOwner);
        return owners.length
          ? owners
          : credits.filter((credit) => credit.role?.toLowerCase() === CreditRole.CHARTER);
      })();

  return [
    ...new Set(selected.map((credit) => credit.creatorId).filter((id) => Number.isFinite(id))),
  ];
}

export function isCharterOrVfxerCredit(role?: string | null): boolean {
  const normalized = (role ?? '').toLowerCase();
  return normalized === CreditRole.CHARTER || normalized === CreditRole.VFXER;
}

async function creatorIdsForLevel(
  levelId: number,
  transaction?: Transaction,
  roles?: string[],
): Promise<number[]> {
  const credits = await LevelCredit.findAll({
    attributes: ['creatorId', 'isOwner', 'role'],
    where: {levelId},
    transaction,
  });
  return selectCreatorIdsForNotification(credits, roles);
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
    creatorIds.push(
      ...(await creatorIdsForLevel(
        recipients.levelId,
        transaction,
        recipients.levelCreditRoles,
      )),
    );
  }
  for (const userId of await userIdsForCreatorIds(creatorIds, transaction)) {
    ids.add(userId);
  }

  return [...ids];
}
