import type {Transaction} from 'sequelize';
import {Op} from 'sequelize';
import User from '@/models/auth/User.js';
import Player from '@/models/players/Player.js';
import Creator from '@/models/credits/Creator.js';
import UserFollow, {
  USER_FOLLOW_TARGET_TYPES,
  type UserFollowTargetType,
} from '@/models/notifications/UserFollow.js';
import {mapMysqlClientError} from '@/misc/utils/db/mysqlClientError.js';

export {USER_FOLLOW_TARGET_TYPES, type UserFollowTargetType};

export class FollowError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'FollowError';
    this.status = status;
  }
}

export interface FollowState {
  following: boolean;
  followerCount: number;
}

export function isFollowTargetType(value: string): value is UserFollowTargetType {
  return (USER_FOLLOW_TARGET_TYPES as readonly string[]).includes(value);
}

async function assertTargetExists(
  targetType: UserFollowTargetType,
  targetId: number,
  transaction?: Transaction,
): Promise<void> {
  if (targetType === 'player') {
    const player = await Player.findByPk(targetId, {attributes: ['id'], transaction});
    if (!player) throw new FollowError('Player not found', 404);
    return;
  }
  const creator = await Creator.findByPk(targetId, {attributes: ['id'], transaction});
  if (!creator) throw new FollowError('Creator not found', 404);
}

function assertNotSelfFollow(
  targetType: UserFollowTargetType,
  targetId: number,
  user: {playerId?: number | null; creatorId?: number | null},
): void {
  if (targetType === 'player' && user.playerId != null && Number(user.playerId) === targetId) {
    throw new FollowError('Cannot follow your own player profile', 400);
  }
  if (targetType === 'creator' && user.creatorId != null && Number(user.creatorId) === targetId) {
    throw new FollowError('Cannot follow your own creator profile', 400);
  }
}

export async function getFollowState(
  targetType: UserFollowTargetType,
  targetId: number,
  viewerUserId?: string | null,
  transaction?: Transaction,
): Promise<FollowState> {
  const [followerCount, existing] = await Promise.all([
    UserFollow.count({
      where: {targetType, targetId},
      transaction,
    }),
    viewerUserId
      ? UserFollow.findOne({
          where: {userId: viewerUserId, targetType, targetId},
          attributes: ['id'],
          transaction,
        })
      : Promise.resolve(null),
  ]);
  return {
    following: Boolean(existing),
    followerCount,
  };
}

export function coercePublicFollows(value: unknown): boolean {
  return value !== false && value !== 0;
}

export interface FollowerListItem {
  userId: string;
  username: string;
  nickname: string | null;
  avatarUrl: string | null;
  playerId: number | null;
  creatorId: number | null;
}

export interface FollowerListResult {
  items: FollowerListItem[];
  page: number;
  limit: number;
  visibleCount: number;
  hiddenCount: number;
}

const FOLLOWERS_MAX_LIMIT = 50;
const FOLLOWERS_DEFAULT_LIMIT = 20;

export function parseFollowerListPaging(query: {
  page?: unknown;
  limit?: unknown;
}): {page: number; limit: number} {
  const pageRaw = parseInt(String(query.page ?? '1'), 10);
  const limitRaw = parseInt(String(query.limit ?? String(FOLLOWERS_DEFAULT_LIMIT)), 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const limit = Number.isFinite(limitRaw)
    ? Math.min(FOLLOWERS_MAX_LIMIT, Math.max(1, limitRaw))
    : FOLLOWERS_DEFAULT_LIMIT;
  return {page, limit};
}

export async function listFollowers(args: {
  targetType: UserFollowTargetType;
  targetId: number;
  page: number;
  limit: number;
  transaction?: Transaction;
}): Promise<FollowerListResult> {
  const {targetType, targetId, page, limit, transaction} = args;
  const offset = (page - 1) * limit;

  const [visibleCount, hiddenCount, rows] = await Promise.all([
    UserFollow.count({
      where: {targetType, targetId, isPublic: true},
      transaction,
    }),
    UserFollow.count({
      where: {targetType, targetId, isPublic: false},
      transaction,
    }),
    UserFollow.findAll({
      attributes: ['userId'],
      where: {targetType, targetId, isPublic: true},
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit,
      offset,
      transaction,
    }),
  ]);

  const userIds = rows.map((row) => row.userId);
  const users = userIds.length
    ? await User.findAll({
        attributes: ['id', 'username', 'nickname', 'avatarUrl', 'playerId', 'creatorId', 'status'],
        where: {id: {[Op.in]: userIds}},
        transaction,
      })
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  const items: FollowerListItem[] = [];
  for (const userId of userIds) {
    const u = byId.get(userId);
    if (!u || u.status === 'banned' || u.status === 'suspended') continue;
    items.push({
      userId: u.id,
      username: u.username,
      nickname: u.nickname ?? null,
      avatarUrl: u.avatarUrl ?? null,
      playerId: u.playerId ?? null,
      creatorId: u.creatorId ?? null,
    });
  }

  return {items, page, limit, visibleCount, hiddenCount};
}

export async function setPublicFollows(
  userId: string,
  publicFollows: boolean,
  transaction?: Transaction,
): Promise<boolean> {
  const user = await User.findByPk(userId, {attributes: ['id', 'publicFollows'], transaction});
  if (!user) throw new FollowError('User not found', 404);
  user.publicFollows = publicFollows;
  await user.save({transaction});
  await UserFollow.update({isPublic: publicFollows}, {where: {userId}, transaction});
  return coercePublicFollows(user.publicFollows);
}

export async function setFollowing(args: {
  user: {id: string; playerId?: number | null; creatorId?: number | null};
  targetType: UserFollowTargetType;
  targetId: number;
  following: boolean;
  transaction?: Transaction;
}): Promise<FollowState> {
  const {user, targetType, targetId, following, transaction} = args;
  if (!Number.isInteger(targetId) || targetId <= 0) {
    throw new FollowError('Invalid target id', 400);
  }
  await assertTargetExists(targetType, targetId, transaction);
  if (following) {
    assertNotSelfFollow(targetType, targetId, user);
    const pref = await User.findByPk(user.id, {attributes: ['publicFollows'], transaction});
    try {
      await UserFollow.create(
        {
          userId: user.id,
          targetType,
          targetId,
          isPublic: coercePublicFollows(pref?.publicFollows),
        },
        {transaction},
      );
    } catch (err) {
      if (mapMysqlClientError(err)?.code !== 'ER_DUP_ENTRY') throw err;
    }
  } else {
    await UserFollow.destroy({
      where: {userId: user.id, targetType, targetId},
      transaction,
    });
  }
  return getFollowState(targetType, targetId, user.id, transaction);
}

export async function listFollowerUserIds(
  targetType: UserFollowTargetType,
  targetIds: number[],
  transaction?: Transaction,
): Promise<string[]> {
  const unique = [...new Set(targetIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (!unique.length) return [];

  const rows = await UserFollow.findAll({
    attributes: ['userId', 'targetId'],
    where: {targetType, targetId: {[Op.in]: unique}},
    transaction,
  });
  if (!rows.length) return [];

  const selfUsers = await User.findAll({
    attributes: ['id', 'playerId', 'creatorId'],
    where:
      targetType === 'player'
        ? {playerId: {[Op.in]: unique}}
        : {creatorId: {[Op.in]: unique}},
    transaction,
  });
  const selfByTarget = new Set<string>();
  for (const self of selfUsers) {
    const ownId = targetType === 'player' ? self.playerId : self.creatorId;
    if (ownId == null) continue;
    selfByTarget.add(`${self.id}:${ownId}`);
  }

  const ids = new Set<string>();
  for (const row of rows) {
    if (selfByTarget.has(`${row.userId}:${row.targetId}`)) continue;
    ids.add(row.userId);
  }
  return [...ids];
}

export async function remapFollowTargets(args: {
  targetType: UserFollowTargetType;
  sourceId: number;
  targetId: number;
  transaction: Transaction;
}): Promise<void> {
  const {targetType, sourceId, targetId, transaction} = args;
  if (sourceId === targetId) return;

  const rows = await UserFollow.findAll({
    where: {targetType, targetId: sourceId},
    transaction,
  });
  for (const row of rows) {
    const existing = await UserFollow.findOne({
      where: {userId: row.userId, targetType, targetId},
      transaction,
    });
    if (existing) {
      await row.destroy({transaction});
    } else {
      await row.update({targetId}, {transaction});
    }
  }
}
