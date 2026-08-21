import type {Request, Response} from 'express';
import {createRateLimiter} from '@/server/decorators/rateLimiter.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {
  FollowError,
  getFollowState,
  setFollowing,
  type UserFollowTargetType,
} from '@/server/services/notifications/FollowService.js';

export const profileFollowLimiter = createRateLimiter({
  type: 'profile_follow',
  windowMs: 60 * 1000,
  maxAttempts: 30,
  blockDuration: 2 * 60 * 1000,
  subjects: ['user', 'ip'],
  failClosed: false,
});

export async function handleFollowPut(
  req: Request,
  res: Response,
  targetType: UserFollowTargetType,
): Promise<Response> {
  const user = req.user;
  if (!user?.id) return res.status(401).json({error: 'User not authenticated'});

  const targetId = parseInt(req.params.id, 10);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return res.status(400).json({error: 'Invalid id'});
  }
  if (typeof req.body?.following !== 'boolean') {
    return res.status(400).json({error: 'following must be a boolean'});
  }

  try {
    const state = await setFollowing({
      user: {
        id: user.id,
        playerId: user.playerId ?? null,
        creatorId: user.creatorId ?? null,
      },
      targetType,
      targetId,
      following: req.body.following,
    });
    return res.json(state);
  } catch (error) {
    if (error instanceof FollowError) {
      return res.status(error.status).json({error: error.message});
    }
    logger.error(`[follow] Failed to update ${targetType} follow`, error);
    return res.status(500).json({error: 'Failed to update follow'});
  }
}

export async function followFieldsForProfile(
  targetType: UserFollowTargetType,
  targetId: number,
  viewerUserId?: string | null,
): Promise<{isFollowing: boolean; followerCount: number}> {
  const state = await getFollowState(targetType, targetId, viewerUserId ?? null);
  return {isFollowing: state.following, followerCount: state.followerCount};
}
