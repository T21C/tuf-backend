import {redis} from '@/server/services/core/RedisService.js';

export const PUSH_HOURLY_CAP = 10;
const WINDOW_SEC = 3600;

export function isOverPushHourlyCap(count: number, cap = PUSH_HOURLY_CAP): boolean {
  return count > cap;
}

export async function consumePushHourlySlot(userId: string): Promise<{
  allowed: boolean;
  count: number;
}> {
  const client = await redis.getClient();
  if (!client) {
    return {allowed: true, count: 0};
  }
  const key = `push:hourly:${userId}`;
  const count = Number(await client.incr(key));
  if (count === 1) {
    await client.expire(key, WINDOW_SEC);
  }
  return {allowed: !isOverPushHourlyCap(count), count};
}
