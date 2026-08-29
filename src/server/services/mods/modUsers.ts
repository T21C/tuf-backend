import {Op} from 'sequelize';
import User from '@/models/auth/User.js';
import {userSummaryFromUser, type ModUserSummary} from './modUserSummary.js';

export {
  displayNameForUser,
  userSummaryFromUser,
  type ModUserSummary,
} from './modUserSummary.js';

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
