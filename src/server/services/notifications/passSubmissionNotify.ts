import type {Transaction} from 'sequelize';
import {PassSubmission} from '@/models/submissions/PassSubmission.js';
import {notificationService} from './NotificationService.js';
import {NOTIFICATION_TYPES} from './types.js';

function passSongArtist(level?: {song?: string | null; artist?: string | null} | null): {
  song: string | null;
  artist: string | null;
} {
  return {
    song: level?.song ?? null,
    artist: level?.artist ?? null,
  };
}

export async function notifyPassSubmissionSubmitted(args: {
  submission: PassSubmission;
  transaction: Transaction;
}): Promise<void> {
  const {submission, transaction} = args;
  await notificationService.notify({
    type: NOTIFICATION_TYPES.PassSubmissionSubmitted,
    payload: {
      submissionId: submission.id,
      passId: null,
      levelId: submission.levelId,
      ...passSongArtist(submission.level),
    },
    recipients: {
      userIds: submission.userId ? [submission.userId] : [],
      playerIds: submission.assignedPlayerId ? [submission.assignedPlayerId] : [],
    },
    skipActor: false,
    actorId: submission.userId ?? null,
    dedupKey: `pass-submission:${submission.id}:submitted`,
    entity: {type: 'level', id: String(submission.levelId)},
    transaction,
  });
}

export async function notifyPassSubmissionOutcome(args: {
  submission: PassSubmission;
  outcome: 'approved' | 'declined';
  passId: number | null;
  actorId?: string | null;
  reason?: string | null;
  transaction: Transaction;
}): Promise<void> {
  const {submission, outcome, passId, transaction} = args;
  const type =
    outcome === 'approved'
      ? NOTIFICATION_TYPES.PassSubmissionApproved
      : NOTIFICATION_TYPES.PassSubmissionDeclined;

  await notificationService.notify({
    type,
    payload: {
      submissionId: submission.id,
      passId,
      levelId: submission.levelId,
      ...passSongArtist(submission.level),
      reason: args.reason ?? null,
    },
    recipients: {
      userIds: submission.userId ? [submission.userId] : [],
      playerIds: submission.assignedPlayerId ? [submission.assignedPlayerId] : [],
    },
    actorId: args.actorId ?? null,
    dedupKey: `pass-submission:${submission.id}:${outcome}`,
    entity: passId
      ? {type: 'pass', id: String(passId)}
      : {type: 'level', id: String(submission.levelId)},
    transaction,
  });
}

export async function notifyPassLifecycle(args: {
  type:
    | typeof NOTIFICATION_TYPES.PassModified
    | typeof NOTIFICATION_TYPES.PassDeleted
    | typeof NOTIFICATION_TYPES.PassRestored;
  pass: {
    id: number;
    playerId?: number | null;
    levelId: number;
    level?: {song?: string | null; artist?: string | null} | null;
  };
  actorId?: string | null;
  reason?: string | null;
  transaction: Transaction;
}): Promise<void> {
  const passId = Number(args.pass.id);
  const levelId = Number(args.pass.levelId);
  if (!Number.isFinite(passId) || !Number.isFinite(levelId)) return;

  await notificationService.notify({
    type: args.type,
    payload: {
      passId,
      levelId,
      ...passSongArtist(args.pass.level),
      reason: args.reason ?? null,
    },
    recipients: {
      playerIds: args.pass.playerId ? [args.pass.playerId] : [],
    },
    actorId: args.actorId ?? null,
    dedupKey: `${args.type}:${passId}:${Date.now()}`,
    entity: {type: 'pass', id: String(passId)},
    transaction: args.transaction,
  });
}
