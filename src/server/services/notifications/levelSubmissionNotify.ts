import type {Transaction} from 'sequelize';
import {notificationService} from './NotificationService.js';
import {NOTIFICATION_TYPES} from './types.js';

export async function notifyChartSubmission(args: {
  outcome: 'submitted' | 'approved' | 'declined';
  submissionId: number;
  userId?: string | null;
  level: {id?: number | null; song?: string | null; artist?: string | null};
  actorId?: string | null;
  reason?: string | null;
  transaction: Transaction;
}): Promise<void> {
  if (!args.userId) return;
  const rawId = Number(args.level.id);
  const levelId = Number.isFinite(rawId) && rawId > 0 ? rawId : null;

  const type =
    args.outcome === 'submitted'
      ? NOTIFICATION_TYPES.ChartSubmissionSubmitted
      : args.outcome === 'approved'
        ? NOTIFICATION_TYPES.ChartSubmissionApproved
        : NOTIFICATION_TYPES.ChartSubmissionDeclined;

  await notificationService.notify({
    type,
    payload: {
      submissionId: args.submissionId,
      levelId,
      song: args.level.song ?? null,
      artist: args.level.artist ?? null,
      reason: args.reason ?? null,
    },
    recipients: {userIds: [args.userId]},
    actorId: args.actorId ?? null,
    skipActor: args.outcome !== 'submitted',
    dedupKey: `chart-submission:${args.submissionId}:${args.outcome}`,
    entity: levelId ? {type: 'level', id: String(levelId)} : {type: 'submission', id: String(args.submissionId)},
    transaction: args.transaction,
  });
}
