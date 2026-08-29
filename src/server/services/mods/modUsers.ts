import {Op} from 'sequelize';
import User from '@/models/auth/User.js';

export type ModUserSummary = {
  userId: string;
  playerId: number | null;
  name: string;
  username: string | null;
};

export function displayNameForUser(user: {
  id: string;
  username?: string | null;
  nickname?: string | null;
}): string {
  const nickname = typeof user.nickname === 'string' ? user.nickname.trim() : '';
  if (nickname) return nickname;
  const username = typeof user.username === 'string' ? user.username.trim() : '';
  if (username) return username;
  return user.id;
}

export function userSummaryFromUser(user: {
  id: string;
  playerId?: number | null;
  username?: string | null;
  nickname?: string | null;
}): ModUserSummary {
  const username = typeof user.username === 'string' ? user.username.trim() : '';
  return {
    userId: user.id,
    playerId: user.playerId ?? null,
    name: displayNameForUser(user),
    username: username || null,
  };
}

export async function loadUserSummariesByIds(userIds: string[]): Promise<Map<string, ModUserSummary>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  const map = new Map<string, ModUserSummary>();
  if (!unique.length) return map;

  const users = await User.findAll({
    where: {id: {[Op.in]: unique}},
    attributes: ['id', 'playerId', 'username', 'nickname'],
  });

  for (const user of users) {
    map.set(user.id, userSummaryFromUser(user));
  }
  return map;
}
