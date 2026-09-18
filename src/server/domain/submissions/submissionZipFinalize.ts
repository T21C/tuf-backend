import { Request, Response } from 'express';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { getSequelizeForModelGroup } from '@/config/db.js';
import LevelSubmission from '@/models/submissions/LevelSubmission.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { getFileIdFromCdnUrl, isWritableCdnUrl } from '@/misc/utils/Utility.js';
import cdnService from '@/server/services/core/CdnService.js';
import { CDN_CONFIG } from '@/externalServices/cdnService/config.js';
import { jobProgressService, isUuidJobId } from '@/server/services/core/JobProgressService.js';
import UploadSession from '@/models/upload/UploadSession.js';
import { cancelSession as cancelUploadSession } from '@/server/services/upload/UploadSessionService.js';
import { SubmissionJobService } from '@/server/services/submissions/SubmissionJobService.js';
import { shouldSkipEnqueue } from '@/server/services/submissions/submissionJobTypes.js';
import { normalizeLevelDlLinkSnapshot } from '@/server/domain/levels/levelDlLinkSnapshot.js';

const submissionsSequelize = getSequelizeForModelGroup('submissions');

export async function assertPendingSubmissionZipEditable(
  submissionId: number,
): Promise<LevelSubmission> {
  const job = await SubmissionJobService.getItemState('level', submissionId);
  if (shouldSkipEnqueue(job?.status) === 'inflight') {
    throw {
      error: 'This submission is already being approved or declined. Wait for it to finish.',
      code: 409,
    };
  }

  const submission = await LevelSubmission.findByPk(submissionId);
  if (!submission) {
    throw { error: 'Submission not found', code: 404 };
  }
  if (submission.status !== 'pending') {
    throw { error: 'Submission is not pending', code: 409 };
  }
  return submission;
}

export function fileIdFromSubmissionDirectDl(directDL: string | null | undefined): string | null {
  if (!directDL) return null;
  return getFileIdFromCdnUrl(directDL);
}

/**
 * Upload buffer to CDN and swap `LevelSubmission.directDL`. No duration checks, Level
 * stats, tags, or webhooks. Optimistic concurrency on `directDL` + pending status.
 */
export async function finalizeSubmissionZipUploadFromBuffer(params: {
  req: Request;
  res: Response | null;
  submissionId: number;
  expectedDirectDL: string | null;
  fileBuffer: Buffer;
  encodedZipFileName: string;
  assembledFilePathToUnlink: string | null;
  uploadSession?: UploadSession | null;
  uploadJobId?: string | null;
  uploadJobMeta?: Record<string, unknown> | null;
}): Promise<void> {
  const {
    req,
    res,
    submissionId,
    expectedDirectDL,
    fileBuffer,
    encodedZipFileName,
    assembledFilePathToUnlink,
    uploadSession,
    uploadJobMeta,
  } = params;

  const uploadJobId =
    params.uploadJobId != null && isUuidJobId(params.uploadJobId) ? params.uploadJobId.trim() : undefined;

  const markJobFailed = async (message: string) => {
    if (!uploadJobId || !req.user?.id) {
      return;
    }
    await jobProgressService
      .patchTrusted(uploadJobId, {
        phase: 'failed',
        error: message,
        message,
        percent: null,
      })
      .catch(() => undefined);
  };

  const jobMetaBase: Record<string, unknown> = {
    submissionId,
    source: 'submission_edit',
    ...(uploadJobMeta && typeof uploadJobMeta === 'object' ? uploadJobMeta : {}),
  };

  try {
    const submissionSnapshot = await assertPendingSubmissionZipEditable(submissionId);

    if (uploadJobId && req.user?.id) {
      await jobProgressService
        .patchTrusted(uploadJobId, {
          ownerUserId: req.user.id,
          kind: 'level_upload',
          phase: 'uploading_to_cdn',
          percent: 5,
          message: 'Sending zip to CDN',
          meta: jobMetaBase,
        })
        .catch(() => undefined);
    }

    let oldFileId: string | null = null;
    const oldDirectDL = submissionSnapshot.directDL;
    if (oldDirectDL && isWritableCdnUrl(oldDirectDL)) {
      oldFileId = fileIdFromSubmissionDirectDl(oldDirectDL);
      logger.debug('Found existing submission CDN file to clean up after upload', {
        submissionId,
        oldFileId,
        oldDirectDL,
      });
    }

    const uploadResult = await cdnService.uploadLevelZip(
      fileBuffer,
      encodedZipFileName,
      uploadJobId || randomUUID(),
    );

    if (assembledFilePathToUnlink) {
      try {
        await fs.promises.unlink(assembledFilePathToUnlink);
      } catch (unlinkError: any) {
        if (unlinkError.code !== 'ENOENT') {
          logger.warn('Failed to clean up assembled file:', unlinkError);
        }
      }
    }
    if (uploadSession) {
      try {
        await cancelUploadSession(uploadSession);
      } catch (sessionCleanupError) {
        logger.warn('Failed to destroy upload session after finalisation:', sessionCleanupError);
      }
    }

    const levelFiles = await cdnService.getLevelFiles(uploadResult.fileId);
    const newDlUrl = `${CDN_CONFIG.baseUrl}/${uploadResult.fileId}`;

    await submissionsSequelize.transaction(async (t) => {
      const fresh = await LevelSubmission.findByPk(submissionId, {
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!fresh) {
        throw { error: 'Submission not found', code: 404 };
      }
      if (fresh.status !== 'pending') {
        try {
          await cdnService.deleteFile(uploadResult.fileId);
        } catch (delErr) {
          logger.warn('Failed to delete CDN file after submission status conflict:', delErr);
        }
        throw {
          error: 'This submission is no longer pending. Refresh the page and try again.',
          code: 409,
        };
      }
      const job = await SubmissionJobService.getItemState('level', submissionId);
      if (shouldSkipEnqueue(job?.status) === 'inflight') {
        try {
          await cdnService.deleteFile(uploadResult.fileId);
        } catch (delErr) {
          logger.warn('Failed to delete CDN file after submission job conflict:', delErr);
        }
        throw {
          error: 'This submission is already being approved or declined. Wait for it to finish.',
          code: 409,
        };
      }
      const currentSnap = normalizeLevelDlLinkSnapshot(fresh.directDL);
      const expectedSnap = normalizeLevelDlLinkSnapshot(expectedDirectDL);
      if (currentSnap !== expectedSnap) {
        try {
          await cdnService.deleteFile(uploadResult.fileId);
        } catch (delErr) {
          logger.warn('Failed to delete CDN file after directDL conflict:', delErr);
        }
        throw {
          error:
            'This submission was modified while the zip was processing (download link changed). Refresh the page and try again.',
          code: 409,
        };
      }
      fresh.directDL = newDlUrl;
      await fresh.save({ transaction: t });
    });

    if (oldFileId) {
      try {
        await cdnService.deleteFileForStoredUrl(oldDirectDL, oldFileId);
        logger.debug('Successfully cleaned up old submission CDN file', {
          submissionId,
          oldFileId,
        });
      } catch (cleanupError) {
        logger.error('Failed to clean up old submission CDN file after successful upload:', {
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          submissionId,
          oldFileId,
          newFileId: uploadResult.fileId,
        });
      }
    }

    if (uploadJobId && req.user?.id) {
      await jobProgressService
        .patchTrusted(uploadJobId, {
          phase: 'completed',
          percent: 100,
          message: 'Upload complete',
          newFileId: uploadResult.fileId,
          meta: { ...jobMetaBase, newFileId: uploadResult.fileId },
        })
        .catch(() => undefined);
    }

    if (!res) {
      return;
    }

    if (res.headersSent || res.writableEnded) {
      logger.warn('Response already sent or ended. Submission upload succeeded but response not sent.', {
        submissionId,
        fileId: uploadResult.fileId,
        userId: req.user?.id,
      });
      return;
    }

    try {
      const submissionAfter = await LevelSubmission.findByPk(submissionId);
      res.json({
        success: true,
        submission: submissionAfter,
        directDL: newDlUrl,
        dlLink: newDlUrl,
        levelFiles,
      });
    } catch (writeError: any) {
      if (
        writeError.code === 'ECONNRESET' ||
        writeError.code === 'EPIPE' ||
        writeError.message?.includes('write after end')
      ) {
        logger.warn('Failed to send response - client may have disconnected. Upload succeeded.', {
          submissionId,
          fileId: uploadResult.fileId,
          userId: req.user?.id,
          error: writeError.message,
        });
        return;
      }
      throw writeError;
    }
  } catch (err: any) {
    if (!res || !res.headersSent) {
      const msg =
        typeof err?.error === 'string' ? err.error : err instanceof Error ? err.message : String(err);
      await markJobFailed(msg);
    }
    throw err;
  }
}
