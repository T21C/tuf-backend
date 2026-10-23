import type {Request, Response} from 'express';
import {createRateLimiter} from '@/server/decorators/rateLimiter.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {
  ProfileNoteError,
  getViewerNote,
  setViewerNote,
  type ProfileNoteTargetType,
} from '@/server/services/notifications/ProfileNoteService.js';

export const profileNoteLimiter = createRateLimiter({
  type: 'profile_note',
  windowMs: 60 * 1000,
  maxAttempts: 30,
  blockDuration: 2 * 60 * 1000,
  subjects: ['user', 'ip'],
  failClosed: false,
});

export async function viewerNoteForProfile(
  targetType: ProfileNoteTargetType,
  targetId: number,
  viewerUserId?: string | null,
): Promise<string | null> {
  return getViewerNote(viewerUserId ?? null, targetType, targetId);
}

export async function handleNotePut(
  req: Request,
  res: Response,
  targetType: ProfileNoteTargetType,
): Promise<Response> {
  const user = req.user;
  if (!user?.id) return res.status(401).json({error: 'User not authenticated'});

  const targetId = parseInt(req.params.id, 10);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return res.status(400).json({error: 'Invalid id'});
  }

  try {
    const text = await setViewerNote({
      userId: user.id,
      targetType,
      targetId,
      text: req.body?.text,
    });
    return res.json({text});
  } catch (error) {
    if (error instanceof ProfileNoteError) {
      return res.status(error.status).json({error: error.message});
    }
    logger.error(`[note] Failed to update ${targetType} note`, error);
    return res.status(500).json({error: 'Failed to update note'});
  }
}
