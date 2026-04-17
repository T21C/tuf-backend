import fs from 'fs';
import type { Request } from 'express';
import type { Transaction } from 'sequelize';

import sequelize from '@/config/db.js';
import { safeTransactionRollback } from '@/misc/utils/Utility.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { sseManager } from '@/misc/utils/server/sse.js';

import cdnService from '@/server/services/core/CdnService.js';
import { CDN_CONFIG } from '@/externalServices/cdnService/config.js';
import EvidenceService from '@/server/services/data/EvidenceService.js';

import LevelSubmission from '@/models/submissions/LevelSubmission.js';
import LevelSubmissionCreatorRequest from '@/models/submissions/LevelSubmissionCreatorRequest.js';
import LevelSubmissionTeamRequest from '@/models/submissions/LevelSubmissionTeamRequest.js';
import LevelSubmissionSongRequest from '@/models/submissions/LevelSubmissionSongRequest.js';
import LevelSubmissionArtistRequest from '@/models/submissions/LevelSubmissionArtistRequest.js';
import type Artist from '@/models/artists/Artist.js';
import LevelSubmissionEvidence from '@/models/submissions/LevelSubmissionEvidence.js';
import { OAuthProvider, User } from '@/models/index.js';

import { levelSubmissionHook } from '@/server/routes/v2/webhooks/webhook.js';
import { cancelSession as cancelUploadSession } from '@/server/services/upload/UploadSessionService.js';
import {
  isUuidJobId,
  jobProgressService,
} from '@/server/services/core/JobProgressService.js';

import { formError } from '../shared/errors.js';
import { cleanUpCdnFile } from '../shared/cdnCleanup.js';
import { parseAndSanitizeLevelForm, type LevelFormSanitised } from './dto.js';
import { computeEvidenceRequirements, validateLevelReferences } from './referenceCheck.js';
import { assertNoDuplicateLevelSubmission } from './duplicateCheck.js';
import { resolveLevelZipSession, type ResolvedLevelZipSession } from './uploadSessionResolver.js';

const evidenceService = EvidenceService.getInstance();

export interface CreateLevelSubmissionInput {
  req: Request;
  userId: string;
  formPayload: Record<string, unknown>;
  uploadSessionId: string | null;
  /**
   * Optional client-generated UUID used to stream CDN-upload progress back to
   * the caller over SSE (`GET /v2/jobs/:jobId/stream`). When present and valid,
   * the service claims the job in Redis before calling the CDN and the CDN
   * ingest endpoint will publish live phase/percent updates.
   */
  uploadJobId: string | null;
  evidenceFiles: Express.Multer.File[];
}

export interface CreateLevelSubmissionResult {
  success: true;
  submissionId: number;
  message: string;
  requiresLevelSelection?: boolean;
  fileId?: string | null;
  levelFiles?: Array<{
    name: string;
    size: number;
    hasYouTubeStream: boolean;
    songFilename?: string;
    artist?: string;
    song?: string;
    author?: string;
    difficulty?: number;
    bpm?: number;
  }>;
}

type CdnLevelFile = Awaited<ReturnType<typeof cdnService.getLevelFiles>>[number];

interface SubmissionRowIds {
  submissionId: number;
  songRequestId: number | null;
  artistRequestId: number | null;
}

/**
 * Runs the full validate → CDN upload → DB rows → evidence → hooks pipeline.
 *
 * Design notes:
 * - The slow CDN upload happens *outside* the database transaction so the tx
 *   only wraps quick writes and commits in hundreds of milliseconds instead
 *   of tens of seconds.
 * - All validation is re-run here; `/validate` is purely a client hint.
 * - Failure paths must clean up (a) the CDN file if we got that far and
 *   (b) the upload session workspace. Evidence tempfiles are cleaned up by
 *   the route (they may originate from multer paths that this service
 *   shouldn't touch).
 */
export async function createLevelSubmission(
  input: CreateLevelSubmissionInput,
): Promise<CreateLevelSubmissionResult> {
  const { userId, formPayload, uploadSessionId, evidenceFiles } = input;
  const uploadJobId =
    input.uploadJobId && isUuidJobId(input.uploadJobId) ? input.uploadJobId : null;

  const markCdnJobFailed = async (message: string) => {
    if (!uploadJobId) return;
    await jobProgressService
      .patchTrusted(uploadJobId, {
        phase: 'failed',
        error: message,
        percent: null,
      })
      .catch(() => undefined);
  };

  // Phase 1: Parse + pure validation (no DB).
  const { sanitized, errors } = parseAndSanitizeLevelForm(formPayload);
  if (errors.length > 0) {
    throw formError.bad('Invalid level submission payload', { details: { fields: errors } });
  }

  // Phase 2: DB-backed validation. Short transaction so we fail fast before uploading.
  {
    const preTx = await sequelize.transaction();
    try {
      await validateLevelReferences(sanitized, preTx);
      await assertNoDuplicateLevelSubmission(sanitized, userId, preTx);
      const evidence = await computeEvidenceRequirements(sanitized, preTx);
      if (evidence.requiresEvidence && evidenceFiles.length === 0) {
        throw formError.bad('Evidence is required for this submission', { field: 'evidence' });
      }
      await preTx.commit();
    } catch (err) {
      await safeTransactionRollback(preTx);
      throw err;
    }
  }

  // Phase 3: resolve + upload the zip (if any) to CDN, OUTSIDE the main tx.
  let resolvedSession: ResolvedLevelZipSession | null = null;
  let uploadedFileId: string | null = null;
  let directDLFromCdn: string | null = null;
  let levelFiles: CdnLevelFile[] = [];

  if (uploadSessionId) {
    resolvedSession = await resolveLevelZipSession(uploadSessionId, userId);

    if (uploadJobId) {
      await jobProgressService
        .patchTrusted(uploadJobId, {
          ownerUserId: userId,
          kind: 'level_submission_upload',
          phase: 'uploading_to_cdn',
          percent: 5,
          message: 'Sending zip to CDN',
          meta: { source: 'level_submission', uploadSessionId },
        })
        .catch(() => undefined);
    }

    try {
      const fileBuffer = await fs.promises.readFile(resolvedSession.assembledPath);
      const uploadResult = await cdnService.uploadLevelZip(
        fileBuffer,
        resolvedSession.originalName,
        uploadJobId ?? undefined,
      );
      uploadedFileId = uploadResult.fileId;
      directDLFromCdn = `${CDN_CONFIG.baseUrl}/${uploadResult.fileId}`;
      levelFiles = await cdnService.getLevelFiles(uploadResult.fileId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markCdnJobFailed(msg);
      await cleanUpCdnFile(uploadedFileId);
      if (resolvedSession) {
        await safeCancelSession(resolvedSession);
      }
      throw formError.bad('Failed to upload zip file to CDN', {
        details: { error: msg },
      });
    }
  }

  // Phase 4: DB write transaction — quick, tight, commits before any more I/O.
  let rowIds: SubmissionRowIds;
  let transaction: Transaction | undefined;
  try {
    transaction = await sequelize.transaction();

    rowIds = await createSubmissionRows({
      sanitized,
      userId,
      directDLFromCdn,
      transaction,
    });

    if (evidenceFiles.length > 0) {
      await uploadEvidenceForSubmission({
        submissionId: rowIds.submissionId,
        songRequestId: rowIds.songRequestId,
        artistRequestId: rowIds.artistRequestId,
        evidenceFiles,
        evidenceType: sanitized.evidenceType,
        transaction,
      });
    }

    const submissionWithAssociations = await LevelSubmission.findByPk(rowIds.submissionId, {
      include: [
        { model: LevelSubmissionCreatorRequest, as: 'creatorRequests' },
        { model: LevelSubmissionTeamRequest, as: 'teamRequestData' },
        { model: LevelSubmissionSongRequest, as: 'songRequest' },
        { model: LevelSubmissionArtistRequest, as: 'artistRequests' },
        { model: LevelSubmissionEvidence, as: 'evidence' },
        {
          model: User,
          as: 'levelSubmitter',
          attributes: ['id', 'username', 'playerId', 'nickname', 'avatarUrl'],
          include: [
            {
              model: OAuthProvider,
              as: 'providers',
              required: false,
              where: { provider: 'discord' },
            },
          ],
        },
      ],
      transaction,
    });

    await transaction.commit();

    // Phase 5: post-commit side effects. Best-effort, never block the response.
    if (submissionWithAssociations) {
      try {
        await levelSubmissionHook(submissionWithAssociations);
      } catch (hookError) {
        logger.warn('levelSubmissionHook failed:', hookError);
      }
    }

    sseManager.broadcast({
      type: 'submissionUpdate',
      data: { action: 'create', submissionId: rowIds.submissionId, submissionType: 'level' },
    });

    if (resolvedSession) {
      await safeCancelSession(resolvedSession);
    }

    if (levelFiles.length > 1) {
      sseManager.broadcast({
        type: 'levelSelection',
        data: {
          fileId: uploadedFileId,
          levelFiles: levelFiles.map(mapLevelFile),
        },
      });
      return {
        success: true,
        submissionId: rowIds.submissionId,
        message: 'Level submission saved successfully',
        requiresLevelSelection: true,
        fileId: uploadedFileId,
        levelFiles: levelFiles.map(mapLevelFile),
      };
    }

    return {
      success: true,
      submissionId: rowIds.submissionId,
      message: 'Level submission saved successfully',
    };
  } catch (err) {
    if (transaction) {
      await safeTransactionRollback(transaction);
    }
    await markCdnJobFailed(err instanceof Error ? err.message : String(err));
    await cleanUpCdnFile(uploadedFileId);
    if (resolvedSession) {
      await safeCancelSession(resolvedSession);
    }
    throw err;
  }
}

async function createSubmissionRows(args: {
  sanitized: LevelFormSanitised;
  userId: string;
  directDLFromCdn: string | null;
  transaction: Transaction;
}): Promise<SubmissionRowIds> {
  const { sanitized, userId, directDLFromCdn, transaction } = args;

  const submission = await LevelSubmission.create(
    {
      artist: sanitized.artist,
      song: sanitized.song,
      suffix: sanitized.suffix,
      songId: sanitized.songId,
      artistId: sanitized.artistId,
      diff: sanitized.diff,
      videoLink: sanitized.videoLink,
      directDL: directDLFromCdn || sanitized.directDL || '',
      userId,
      wsLink: sanitized.wsLink || '',
      status: 'pending',
      charter: '',
      vfxer: '',
      team: '',
    },
    { transaction },
  );

  if (sanitized.creatorRequests.length > 0) {
    await Promise.all(
      sanitized.creatorRequests.map((request) =>
        LevelSubmissionCreatorRequest.create(
          {
            submissionId: submission.id,
            creatorName: request.creatorName,
            creatorId: request.creatorId ?? null,
            role: request.role,
            isNewRequest: request.isNewRequest ?? false,
          },
          { transaction },
        ),
      ),
    );
  }

  if (sanitized.teamRequest) {
    await LevelSubmissionTeamRequest.create(
      {
        submissionId: submission.id,
        teamName: sanitized.teamRequest.teamName,
        teamId: sanitized.teamRequest.teamId ?? null,
        isNewRequest: sanitized.teamRequest.isNewRequest ?? false,
      },
      { transaction },
    );
  }

  let songRequestId: number | null = null;
  if (sanitized.isNewSongRequest || sanitized.songId) {
    const songRequest = await LevelSubmissionSongRequest.create(
      {
        submissionId: submission.id,
        songId: sanitized.songId,
        songName: sanitized.isNewSongRequest ? sanitized.song : null,
        isNewRequest: sanitized.isNewSongRequest,
      },
      { transaction },
    );
    songRequestId = songRequest.id;
    await submission.update({ songRequestId: songRequest.id }, { transaction });
  }

  let artistRequestId: number | null = null;
  if (sanitized.artistRequests.length > 0) {
    const createdRequests = await Promise.all(
      sanitized.artistRequests.map((request) =>
        LevelSubmissionArtistRequest.create(
          {
            submissionId: submission.id,
            artistId: request.artistId,
            artistName: request.artistName,
            isNewRequest: request.isNewRequest,
            verificationState: (request.verificationState as Artist['verificationState'] | null) || 'pending',
          },
          { transaction },
        ),
      ),
    );
    if (createdRequests.length > 0) artistRequestId = createdRequests[0].id;
  } else if (sanitized.isNewArtistRequest || sanitized.artistId) {
    const artistRequest = await LevelSubmissionArtistRequest.create(
      {
        submissionId: submission.id,
        artistId: sanitized.artistId,
        artistName: sanitized.isNewArtistRequest ? sanitized.artist : null,
        isNewRequest: sanitized.isNewArtistRequest,
        verificationState: 'pending',
      },
      { transaction },
    );
    artistRequestId = artistRequest.id;
  }

  if (artistRequestId) {
    await submission.update({ artistRequestId }, { transaction });
  }

  return { submissionId: submission.id, songRequestId, artistRequestId };
}

async function uploadEvidenceForSubmission(args: {
  submissionId: number;
  songRequestId: number | null;
  artistRequestId: number | null;
  evidenceFiles: Express.Multer.File[];
  evidenceType: 'song' | 'artist';
  transaction: Transaction;
}): Promise<void> {
  const { submissionId, songRequestId, artistRequestId, evidenceFiles, evidenceType, transaction } =
    args;

  const requestId = evidenceType === 'song' ? songRequestId : artistRequestId;

  const evidenceBuffers = await Promise.all(
    evidenceFiles.map((file) => fs.promises.readFile(file.path)),
  );

  await evidenceService.uploadEvidenceImages(
    submissionId,
    evidenceFiles.map(
      (file, idx) =>
        ({
          buffer: evidenceBuffers[idx],
          originalname: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          fieldname: file.fieldname,
        } as Express.Multer.File),
    ),
    evidenceType,
    requestId,
    transaction,
  );
}

async function safeCancelSession(resolved: ResolvedLevelZipSession): Promise<void> {
  try {
    await cancelUploadSession(resolved.session);
  } catch (err) {
    logger.warn('Failed to cancel upload session after submission:', err);
  }
}

function mapLevelFile(file: CdnLevelFile) {
  return {
    name: file.name,
    size: file.size,
    hasYouTubeStream: file.hasYouTubeStream,
    songFilename: file.songFilename,
    artist: file.artist,
    song: file.song,
    author: file.author,
    difficulty: file.difficulty,
    bpm: file.bpm,
  };
}
