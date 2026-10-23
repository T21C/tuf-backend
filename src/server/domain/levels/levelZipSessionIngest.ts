import fs from 'fs';
import { randomUUID } from 'crypto';
import type UploadSession from '@/models/upload/UploadSession.js';
import {
  UploadError,
  cancelSession as cancelUploadSession,
  getOwnedSession,
} from '@/server/services/upload/UploadSessionService.js';
import cdnService, { CdnError } from '@/server/services/core/CdnService.js';
import { CDN_CONFIG } from '@/externalServices/cdnService/config.js';
import { cleanUpCdnFile } from '@/server/routes/v2/misc/form/shared/cdnCleanup.js';
import { isUuidJobId, jobProgressService } from '@/server/services/core/JobProgressService.js';
import { logger } from '@/server/services/core/LoggerService.js';

export type LevelZipSessionPurpose = 'submission' | 'levelRequest';

export class LevelZipSessionError extends Error {
  readonly status: number;
  readonly field?: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, message: string, field?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'LevelZipSessionError';
    this.status = status;
    this.field = field;
    this.details = details;
  }
}

export interface ResolvedLevelZipSession {
  session: UploadSession;
  assembledPath: string;
  originalName: string;
  declaredSize: number;
}

export type IngestedLevelZipChart = {
  name: string;
  relativePath?: string;
  fullPath?: string;
  storagePath?: string;
  size: number;
  hasYouTubeStream: boolean;
  songFilename?: string;
  artist?: string;
  song?: string;
  author?: string;
  difficulty?: number;
  bpm?: number;
};

export interface IngestedLevelZip {
  session: ResolvedLevelZipSession;
  fileId: string;
  directDl: string;
  originalName: string;
  zipSizeBytes: number;
  levelFiles: IngestedLevelZipChart[];
}

function sessionError(
  status: number,
  message: string,
  field = 'uploadSessionId',
  details?: Record<string, unknown>,
) {
  return new LevelZipSessionError(status, message, field, details);
}

/**
 * Look up an assembled level-zip session owned by `userId` and minted for `purpose`.
 * A submission session cannot be consumed by a download request, and the reverse.
 */
export async function resolveOwnedLevelZipSession(
  sessionId: string,
  userId: string,
  purpose: LevelZipSessionPurpose,
): Promise<ResolvedLevelZipSession> {
  if (!sessionId || typeof sessionId !== 'string') {
    throw sessionError(400, 'Invalid uploadSessionId');
  }

  let session: UploadSession;
  try {
    session = await getOwnedSession(sessionId, userId);
  } catch (err) {
    if (err instanceof UploadError) {
      throw sessionError(err.status, err.message);
    }
    throw err;
  }

  if (session.kind !== 'level-zip') {
    throw sessionError(400, 'Upload session is not a level-zip session', 'uploadSessionId', {
      kind: session.kind,
    });
  }

  const forSubmission = session.meta?.forSubmission === true;
  const forLevelRequest = session.meta?.forLevelRequest === true;
  if (forSubmission && forLevelRequest) {
    throw sessionError(400, 'Upload session has conflicting purpose flags');
  }
  const actual: LevelZipSessionPurpose | null = forSubmission
    ? 'submission'
    : forLevelRequest
      ? 'levelRequest'
      : null;
  if (actual !== purpose) {
    throw sessionError(
      403,
      purpose === 'submission'
        ? 'Upload session was not created for a new submission'
        : 'Upload session was not created for a level request',
    );
  }

  if (session.status !== 'assembled' || !session.assembledPath) {
    throw sessionError(409, `Upload session is not assembled (status: ${session.status})`);
  }

  try {
    await fs.promises.access(session.assembledPath, fs.constants.R_OK);
  } catch {
    throw sessionError(409, 'Assembled zip file is missing on disk');
  }

  return {
    session,
    assembledPath: session.assembledPath,
    originalName: session.originalName,
    declaredSize: session.declaredSize,
  };
}

function mapLevelFile(file: IngestedLevelZipChart): IngestedLevelZipChart {
  return {
    name: file.name,
    relativePath: file.relativePath,
    fullPath: file.fullPath || file.relativePath,
    storagePath: file.storagePath,
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

async function markJobFailed(uploadJobId: string | null, message: string) {
  if (!uploadJobId) return;
  await jobProgressService
    .patchTrusted(uploadJobId, { phase: 'failed', error: message, percent: null })
    .catch(() => undefined);
}

/**
 * Resolve an assembled session and ingest it as a CDN LEVELZIP.
 * On failure the new CDN object (if any) and the session workspace are removed.
 * The caller cancels the session after the database row that points at the file is saved.
 */
export async function ingestOwnedLevelZip(input: {
  uploadSessionId: string;
  userId: string;
  uploadJobId: string | null;
  purpose: LevelZipSessionPurpose;
  jobKind: string;
  jobSource: string;
}): Promise<IngestedLevelZip> {
  const uploadJobId = input.uploadJobId && isUuidJobId(input.uploadJobId) ? input.uploadJobId : null;
  let resolved: ResolvedLevelZipSession | null = null;
  let uploadedFileId: string | null = null;
  try {
    resolved = await resolveOwnedLevelZipSession(input.uploadSessionId, input.userId, input.purpose);
    if (uploadJobId) {
      await jobProgressService
        .patchTrusted(uploadJobId, {
          ownerUserId: input.userId,
          kind: input.jobKind,
          phase: 'uploading_to_cdn',
          percent: 5,
          message: 'Sending zip to CDN',
          meta: { source: input.jobSource, uploadSessionId: input.uploadSessionId },
        })
        .catch(() => undefined);
    }
    const uploadResult = await cdnService.uploadLevelZip(
      resolved.assembledPath,
      resolved.originalName,
      uploadJobId ?? randomUUID(),
    );
    uploadedFileId = uploadResult.fileId;
    const levelFiles = await cdnService.getLevelFiles(uploadResult.fileId);
    return {
      session: resolved,
      fileId: uploadResult.fileId,
      directDl: `${CDN_CONFIG.baseUrl}/${uploadResult.fileId}`,
      originalName: resolved.originalName,
      zipSizeBytes: resolved.declaredSize,
      levelFiles: levelFiles.map(mapLevelFile),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markJobFailed(uploadJobId, msg);
    await cleanUpCdnFile(uploadedFileId);
    if (resolved) await cancelResolvedSession(resolved);
    if (err instanceof LevelZipSessionError || err instanceof CdnError) throw err;
    throw sessionError(400, msg || 'Failed to upload zip file to CDN', 'uploadSessionId', { error: msg });
  }
}

async function cancelResolvedSession(resolved: ResolvedLevelZipSession): Promise<void> {
  try {
    await cancelUploadSession(resolved.session);
  } catch (err) {
    logger.warn('Failed to cancel upload session after level zip ingest:', err);
  }
}

/** Drop the chunk workspace after the CDN file has been stored on a row. */
export async function cancelIngestedLevelZipSession(ingested: IngestedLevelZip | null): Promise<void> {
  if (!ingested) return;
  await cancelResolvedSession(ingested.session);
}

/** Delete the ingested CDN file and the chunk workspace. Used when the row write fails. */
export async function discardIngestedLevelZip(ingested: IngestedLevelZip | null): Promise<void> {
  if (!ingested) return;
  await cleanUpCdnFile(ingested.fileId);
  await cancelIngestedLevelZipSession(ingested);
}
