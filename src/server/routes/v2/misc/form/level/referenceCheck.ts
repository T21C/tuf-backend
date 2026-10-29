import { Op, type Transaction } from 'sequelize';
import Song from '@/models/songs/Song.js';
import Artist from '@/models/artists/Artist.js';
import LevelTag from '@/models/levels/LevelTag.js';
import { isAutomaticLevelTagName } from '@/misc/utils/data/automaticLevelTags.js';
import { computeSubmissionEvidenceRequirements } from '@/server/submissions/submissionEvidenceRules.js';

import { formError } from '../shared/errors.js';
import type { LevelFormSanitised } from './dto.js';

export interface EvidenceRequirements {
  requiresSongEvidence: boolean;
  requiresArtistEvidence: boolean;
  requiresEvidence: boolean;
}

/**
 * Cheap reference existence check: if the user claimed an existing songId /
 * artistId, assert it resolves. Throws a 400 FormError otherwise. Runs inside
 * the caller's transaction so the read is consistent with any later writes.
 */
export async function validateLevelReferences(
  sanitized: LevelFormSanitised,
  transaction: Transaction,
): Promise<void> {
  if (!sanitized.isNewSongRequest && sanitized.songId != null) {
    const song = await Song.findByPk(sanitized.songId, { transaction });
    if (!song) {
      throw formError.bad(`Song with ID ${sanitized.songId} does not exist`, { field: 'songId' });
    }
  }
  if (!sanitized.isNewArtistRequest && sanitized.artistId != null) {
    const artist = await Artist.findByPk(sanitized.artistId, { transaction });
    if (!artist) {
      throw formError.bad(`Artist with ID ${sanitized.artistId} does not exist`, { field: 'artistId' });
    }
  }
  await assertRequestedTagIdsExist(sanitized.tagIds, transaction);
}

export async function assertRequestedTagIdsExist(
  tagIds: number[],
  transaction?: Transaction,
): Promise<void> {
  if (tagIds.length === 0) return;
  const tags = await LevelTag.findAll({
    where: { id: { [Op.in]: tagIds } },
    attributes: ['id', 'name', 'charterManagable'],
    transaction,
  });
  if (tags.length !== tagIds.length) {
    throw formError.bad('One or more tag IDs are invalid', { field: 'tagIds' });
  }
  if (tags.some((tag) => isAutomaticLevelTagName(tag.name))) {
    throw formError.bad('Tags read from the level file are set by the parser, not by request', { field: 'tagIds' });
  }
  if (tags.some((tag) => !tag.charterManagable)) {
    throw formError.bad('Only charter-managed tags can be requested', { field: 'tagIds' });
  }
}

/**
 * Resolve the evidence-required booleans for the sanitised payload. Delegates
 * to the shared rules so display-side and server-side stay consistent.
 */
export async function computeEvidenceRequirements(
  sanitized: LevelFormSanitised,
  transaction: Transaction,
): Promise<EvidenceRequirements> {
  const { requiresSongEvidence, requiresArtistEvidence } = await computeSubmissionEvidenceRequirements(
    {
      isNewSongRequest: sanitized.isNewSongRequest,
      songId: sanitized.songId,
      isNewArtistRequest: sanitized.isNewArtistRequest,
      artistId: sanitized.artistId,
    },
    sanitized.artistRequests,
    transaction,
  );
  return {
    requiresSongEvidence,
    requiresArtistEvidence,
    requiresEvidence: requiresSongEvidence || requiresArtistEvidence,
  };
}
