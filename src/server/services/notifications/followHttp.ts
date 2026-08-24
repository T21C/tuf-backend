import type {Request, Response} from 'express';
import {createRateLimiter} from '@/server/decorators/rateLimiter.js';
import {logger} from '@/server/services/core/LoggerService.js';
import Player from '@/models/players/Player.js';
import Creator from '@/models/credits/Creator.js';
import {
  FollowError,
  getFollowState,
  listFollowers,
  parseFollowerListPaging,
  setFollowing,
  setPublicFollows,
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

/** MySQL BOOLEAN may come back as 0/1. Missing values default to shown. */
export function coerceShowFollowerCount(value: unknown): boolean {
  return value !== false && value !== 0;
}

const EMPTY_FOLLOWER_LIST = (page: number, limit: number) => ({
  items: [],
  page,
  limit,
  visibleCount: 0,
  hiddenCount: 0,
});

export async function handleFollowersGet(
  req: Request,
  res: Response,
  targetType: UserFollowTargetType,
): Promise<Response> {
  const targetId = parseInt(req.params.id, 10);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return res.status(400).json({error: 'Invalid id'});
  }
  const {page, limit} = parseFollowerListPaging(req.query);

  try {
    const row =
      targetType === 'player'
        ? await Player.findByPk(targetId, {attributes: ['id', 'showFollowerCount']})
        : await Creator.findByPk(targetId, {attributes: ['id', 'showFollowerCount']});
    if (!row) {
      return res.status(404).json({
        error: targetType === 'player' ? 'Player not found' : 'Creator not found',
      });
    }

    const isOwner =
      targetType === 'player'
        ? Boolean(req.user?.playerId && Number(req.user.playerId) === targetId)
        : Boolean(req.user?.creatorId && Number(req.user.creatorId) === targetId);

    if (!coerceShowFollowerCount(row.showFollowerCount) && !isOwner) {
      return res.json(EMPTY_FOLLOWER_LIST(page, limit));
    }

    const result = await listFollowers({targetType, targetId, page, limit});
    return res.json(result);
  } catch (error) {
    logger.error(`[follow] Failed to list ${targetType} followers`, error);
    return res.status(500).json({error: 'Failed to list followers'});
  }
}

export async function handlePublicFollowsPatch(req: Request, res: Response): Promise<Response> {
  const user = req.user;
  if (!user?.id) return res.status(401).json({error: 'User not authenticated'});
  if (typeof req.body?.publicFollows !== 'boolean') {
    return res.status(400).json({error: 'publicFollows must be a boolean'});
  }

  try {
    const publicFollows = await setPublicFollows(user.id, req.body.publicFollows);
    return res.json({publicFollows});
  } catch (error) {
    if (error instanceof FollowError) {
      return res.status(error.status).json({error: error.message});
    }
    logger.error('[follow] Failed to update public follows', error);
    return res.status(500).json({error: 'Failed to update follow visibility'});
  }
}
