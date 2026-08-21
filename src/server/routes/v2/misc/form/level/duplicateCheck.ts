import { Op, type Transaction } from 'sequelize';
import LevelSubmission from '@/models/submissions/LevelSubmission.js';

import { formError } from '../shared/errors.js';
import type { LevelFormSanitised } from './dto.js';

function emptyOrNull(value: string | null): boolean {
  return value == null || value === '';
}

/**
 * Single lookup against pending submissions owned by `userId` with the same
 * (song, suffix, videoLink, download) identity. Throws a 409 FormError if one
 * exists. Different suffixes or download links of the same song are allowed.
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
      userId,
      song: sanitized.song,
      ...(emptyOrNull(sanitized.suffix)
        ? { [Op.or]: [{ suffix: null }, { suffix: '' }] }
        : { suffix: sanitized.suffix }),
      videoLink: sanitized.videoLink,
      directDL: sanitized.directDL || '',
      wsLink: sanitized.wsLink || '',
    },
    transaction,
  });

  if (existing) {
    throw formError.conflict("You've already submitted this level, please wait for approval.", {
      details: { submissionId: existing.id },
    });
  }
}
