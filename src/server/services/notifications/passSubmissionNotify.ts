import type {Transaction} from 'sequelize';
import {PassSubmission} from '@/models/submissions/PassSubmission.js';
import {notificationService} from './NotificationService.js';
import {NOTIFICATION_TYPES} from './types.js';

export async function notifyPassSubmissionOutcome(args: {
  submission: PassSubmission;
  outcome: 'approved' | 'declined';
  passId: number | null;
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
      song: submission.level?.song ?? null,
      artist: submission.level?.artist ?? null,
    },
    recipients: {
      userIds: submission.userId ? [submission.userId] : [],
      playerIds: submission.assignedPlayerId ? [submission.assignedPlayerId] : [],
    },
    dedupKey: `pass-submission:${submission.id}:${outcome}`,
    entity: passId
      ? {type: 'pass', id: String(passId)}
      : {type: 'level', id: String(submission.levelId)},
    transaction,
  });
}
