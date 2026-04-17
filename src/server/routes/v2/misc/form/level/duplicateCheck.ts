import type { Transaction } from 'sequelize';
import LevelSubmission from '@/models/submissions/LevelSubmission.js';

import { formError } from '../shared/errors.js';
import type { LevelFormSanitised } from './dto.js';

/**
 * Single indexed lookup against pending submissions owned by `userId` with the
 * same (artist, song, videoLink) triple. Throws a 409 FormError if one exists.
 *
 * `/validate` and `/submit` both call this; because the underlying query is
 * idempotent the repeated cost is negligible and we avoid the complexity of
 * passing around a validation ticket.
 */
export async function assertNoDuplicateLevelSubmission(
  sanitized: LevelFormSanitised,
  userId: string,
  transaction: Transaction,
): Promise<void> {
  const existing = await LevelSubmission.findOne({
    where: {
      status: 'pending',
      artist: sanitized.artist,
      song: sanitized.song,
      userId,
      videoLink: sanitized.videoLink,
    },
    transaction,
  });

  if (existing) {
    throw formError.conflict("You've already submitted this level, please wait for approval.", {
      details: { submissionId: existing.id },
    });
  }
}
