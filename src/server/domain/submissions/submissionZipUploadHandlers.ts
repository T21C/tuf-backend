import fs from 'fs';
import { Request, Response } from 'express';
import LevelSubmission from '@/models/submissions/LevelSubmission.js';
import LevelSubmissionSongRequest from '@/models/submissions/LevelSubmissionSongRequest.js';
import Song from '@/models/songs/Song.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { isCdnUrl, isWritableCdnUrl } from '@/misc/utils/Utility.js';
import cdnService, {
  httpStatusFromHandlerError,
  jsonBodyFromHandlerError,
} from '@/server/services/core/CdnService.js';
import { jobProgressService, isUuidJobId } from '@/server/services/core/JobProgressService.js';
import UploadSession from '@/models/upload/UploadSession.js';
import {
  cancelSession as cancelUploadSession,
  destroySession,
} from '@/server/services/upload/UploadSessionService.js';
import {
  asZipUrlDownloadFailure,
  downloadZipFromUrl,
  isValidHttpUrl,
} from '@/misc/utils/data/levelZipFromUrl.js';
import {
  downloadSteamWorkshopItemToZipBuffer,
  parseSteamWorkshopPublishedFileId,
} from '@/misc/utils/data/steamWorkshopLevelZip.js';
import { isYsmodOnlyState } from '@/server/submissions/submissionEvidenceRules.js';
import { matchLevelFileBySelection } from '@/externalServices/cdnService/domain/level/matchLevelFileSelection.js';
import { normalizeLevelDlLinkSnapshot } from '@/server/domain/levels/levelDlLinkSnapshot.js';
import { encodeZipFilenameForCdn } from '@/server/domain/levels/levelZipFilename.js';
import { activeLevelZipFinalizeBySubmissionId } from '@/server/domain/levels/levelZipUploadConcurrency.js';
import {
  isAssembledZipMissingError,
  readAssembledLevelZipFromPath,
} from '@/server/domain/levels/levelZipUploadRead.js';
import {
  assertPendingSubmissionZipEditable,
  fileIdFromSubmissionDirectDl,
  finalizeSubmissionZipUploadFromBuffer,
} from '@/server/domain/submissions/submissionZipFinalize.js';

function sendSubmissionZipHandlerError(res: Response, error: unknown, fallbackMessage: string): void {
  const statusCode = httpStatusFromHandlerError(error);
  if (statusCode >= 500) {
    logger.error(fallbackMessage, error);
  }
  if (res.headersSent) {
    return;
  }
  res.status(statusCode).json(jsonBodyFromHandlerError(error, fallbackMessage));
}

function parseSubmissionIdParam(req: Request): number {
  const submissionId = parseInt(req.params.id, 10);
  if (!Number.isInteger(submissionId) || submissionId <= 0) {
    throw { error: 'Invalid submission ID', code: 400 };
  }
  return submissionId;
}

function sessionMetaSubmissionId(session: UploadSession): number | null {
  const raw = session.meta?.submissionId;
  if (raw == null || raw === '') {
    return null;
  }
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function handlePostSubmissionZipUpload(req: Request, res: Response): Promise<void> {
  let uploadSession: UploadSession | null = null;
  let assembledFilePath = '';
  let encodedZipFileName = '';

  try {
    const { sessionId, uploadJobId: rawUploadJobId } = req.body;
    const uploadJobId = isUuidJobId(rawUploadJobId) ? rawUploadJobId.trim() : undefined;
    const submissionId = parseSubmissionIdParam(req);

    if (!sessionId || typeof sessionId !== 'string') {
      throw { error: 'Missing sessionId', code: 400 };
    }

    uploadSession = await UploadSession.findByPk(sessionId);
    if (!uploadSession) throw { error: 'Upload session not found', code: 404 };
    if (uploadSession.userId !== req.user?.id) throw { error: 'Forbidden', code: 403 };
    if (uploadSession.kind !== 'level-zip') {
      throw { error: 'Upload session is not for a level zip', code: 400 };
    }
    if (uploadSession.status !== 'assembled' || !uploadSession.assembledPath) {
      throw { error: 'Upload session has no assembled file yet', code: 409 };
    }
    const metaSubmissionId = sessionMetaSubmissionId(uploadSession);
    if (metaSubmissionId !== submissionId) {
      throw { error: 'Upload session is not for this submission', code: 400 };
    }
    assembledFilePath = uploadSession.assembledPath;
    encodedZipFileName = uploadSession.originalName;

    const submission = await assertPendingSubmissionZipEditable(submissionId);
    const expectedLink = normalizeLevelDlLinkSnapshot(submission.directDL);

    try {
      await fs.promises.access(assembledFilePath, fs.constants.R_OK);
    } catch {
      logger.warn('Submission zip upload: session marked assembled but assembled file is missing; invalidating session', {
        sessionId,
        assembledFilePath,
      });
      if (uploadSession) {
        try {
          await destroySession(uploadSession);
        } catch (destroyErr) {
          logger.warn('Failed to destroy orphaned upload session:', destroyErr);
        }
      }
      throw {
        error:
          'Assembled upload file is missing (workspace cleaned or disk out of sync). Start a fresh chunked upload.',
        code: 409,
      };
    }

    if (activeLevelZipFinalizeBySubmissionId.has(submissionId)) {
      throw {
        error: 'Another zip upload is already processing for this submission. Wait for it to finish.',
        code: 409,
      };
    }

    const runFinalizeOnce = async (response: Response | null, preloadedZipBuffer?: Buffer) => {
      const fileBuffer =
        preloadedZipBuffer ?? (await readAssembledLevelZipFromPath(assembledFilePath));

      await finalizeSubmissionZipUploadFromBuffer({
        req,
        res: response,
        submissionId,
        expectedDirectDL: expectedLink,
        fileBuffer,
        encodedZipFileName,
        assembledFilePathToUnlink: null,
        uploadSession,
        uploadJobId,
      });
    };

    if (uploadJobId) {
      activeLevelZipFinalizeBySubmissionId.set(submissionId, uploadJobId);
      if (req.user?.id) {
        await jobProgressService
          .patchTrusted(uploadJobId, {
            ownerUserId: req.user.id,
            kind: 'level_upload',
            phase: 'queued',
            percent: 0,
            message: 'Reading assembled zip…',
            meta: { submissionId, source: 'submission_edit', stage: 'prepare' },
          })
          .catch(() => undefined);
      }

      let zipSnapshot: Buffer;
      try {
        zipSnapshot = await readAssembledLevelZipFromPath(assembledFilePath);
      } catch (readErr) {
        activeLevelZipFinalizeBySubmissionId.delete(submissionId);
        const missing = isAssembledZipMissingError(readErr);
        if (missing && uploadSession) {
          try {
            await destroySession(uploadSession);
          } catch (destroyErr) {
            logger.warn('Failed to destroy session after missing assembled file:', destroyErr);
          }
        }
        const readFailMsg = readErr instanceof Error ? readErr.message : String(readErr);
        await jobProgressService
          .patchTrusted(uploadJobId, {
            phase: 'failed',
            error: readFailMsg,
            message: readFailMsg,
            percent: null,
          })
          .catch(() => undefined);
        throw {
          error: readErr instanceof Error ? readErr.message : String(readErr),
          code: missing ? 409 : 500,
        };
      }

      void (async () => {
        try {
          await runFinalizeOnce(null, zipSnapshot);
        } catch (err) {
          logger.error('Async submission zip finalise failed', {
            submissionId,
            err,
          });
        } finally {
          activeLevelZipFinalizeBySubmissionId.delete(submissionId);
        }
      })();

      res.status(202).json({
        accepted: true,
        uploadJobId,
        submissionId,
        message: 'Processing started',
      });
      return;
    }

    activeLevelZipFinalizeBySubmissionId.set(submissionId, 'sync');
    try {
      try {
        await runFinalizeOnce(res);
      } catch (error) {
        if (uploadSession) {
          try {
            if (isAssembledZipMissingError(error)) {
              await destroySession(uploadSession);
            } else {
              await cancelUploadSession(uploadSession);
            }
          } catch (cleanupError) {
            logger.warn('Failed to clean up upload session after error:', cleanupError);
          }
        }
        throw error;
      }
    } finally {
      activeLevelZipFinalizeBySubmissionId.delete(submissionId);
    }
  } catch (error: any) {
    if (error instanceof Error && error.message.includes('Client disconnected')) {
      logger.warn('Client disconnected during submission file upload:', {
        submissionId: req.params.id,
        userId: req.user?.id,
      });
      if (!res.headersSent && !res.writableEnded) {
        try {
          res.status(499).json({
            error: 'Client disconnected during upload',
          });
        } catch (writeError: any) {
          if (writeError.code !== 'ECONNRESET' && writeError.code !== 'EPIPE') {
            logger.warn('Error sending disconnect response:', writeError);
          }
        }
      }
      return;
    }

    if (isAssembledZipMissingError(error)) {
      if (!res.headersSent) {
        res.status(409).json({
          error:
            error instanceof Error
              ? error.message
              : 'Assembled upload file is missing. Start a fresh chunked upload.',
          code: 409,
        });
      }
      return;
    }
    sendSubmissionZipHandlerError(res, error, 'Failed to upload submission file');
  }
}

export async function handlePostSubmissionZipUploadFromUrl(req: Request, res: Response): Promise<void> {
  try {
    const { url, uploadJobId: rawUploadJobId } = req.body;
    const uploadJobId = isUuidJobId(rawUploadJobId) ? rawUploadJobId.trim() : undefined;
    const submissionId = parseSubmissionIdParam(req);
    if (!url || typeof url !== 'string') {
      throw { error: 'Missing url', code: 400 };
    }
    const trimmed = url.trim();
    if (!trimmed) {
      throw { error: 'Missing url', code: 400 };
    }
    const workshopPublishedFileId = parseSteamWorkshopPublishedFileId(trimmed);
    if (!workshopPublishedFileId && !isValidHttpUrl(trimmed)) {
      throw { error: 'Invalid download URL', code: 400 };
    }
    if (isValidHttpUrl(trimmed) && isCdnUrl(trimmed)) {
      throw { error: 'URL must not point to the site CDN', code: 400 };
    }

    const submission = await assertPendingSubmissionZipEditable(submissionId);
    const expectedDirectDL = normalizeLevelDlLinkSnapshot(submission.directDL);
    const encodedZipFileName = encodeZipFilenameForCdn(submission.song, submission.artist);

    if (activeLevelZipFinalizeBySubmissionId.has(submissionId)) {
      throw {
        error: 'Another zip upload is already processing for this submission. Wait for it to finish.',
        code: 409,
      };
    }

    if (uploadJobId && req.user?.id) {
      await jobProgressService
        .patchTrusted(uploadJobId, {
          ownerUserId: req.user.id,
          kind: 'level_upload',
          phase: 'downloading_remote',
          percent: 0,
          message: workshopPublishedFileId ? 'Starting Steam Workshop download' : 'Starting download',
          meta: {
            submissionId,
            source: 'upload_from_url',
            stage: 'download',
          },
        })
        .catch(() => undefined);
    }

    let lastDownloadProgressAt = 0;
    let lastDownloadPercent = -1;
    let lastEmittedLoaded = -1;
    const emitDownloadProgress = async (loaded: number, total: number, percent: number) => {
      if (!uploadJobId || !req.user?.id) {
        return;
      }
      const now = Date.now();
      const terminal = percent >= 100;
      if (!terminal) {
        if (total > 0) {
          if (now - lastDownloadProgressAt < 350 && Math.abs(percent - lastDownloadPercent) < 2) {
            return;
          }
        } else if (now - lastDownloadProgressAt < 400 && loaded - lastEmittedLoaded < 2 * 1024 * 1024) {
          return;
        }
      }
      lastDownloadProgressAt = now;
      lastDownloadPercent = percent;
      lastEmittedLoaded = loaded;
      const mb = (loaded / (1024 * 1024)).toFixed(1);
      await jobProgressService
        .patchTrusted(uploadJobId, {
          phase: 'downloading_remote',
          percent,
          message: total > 0 ? `Downloading zip` : `Downloading zip (${mb} MB)`,
          meta: {
            submissionId,
            source: 'upload_from_url',
            stage: 'download',
            downloadBytes: loaded,
            downloadTotal: total > 0 ? total : null,
          },
        })
        .catch(() => undefined);
    };

    let fileBuffer: Buffer;
    try {
      if (workshopPublishedFileId) {
        fileBuffer = await downloadSteamWorkshopItemToZipBuffer(workshopPublishedFileId, {
          onProgress: ({ loaded, total, percent }) =>
            emitDownloadProgress(loaded, total, percent),
        });
      } else {
        fileBuffer = await downloadZipFromUrl(trimmed, {
          onProgress: ({ loaded, total, percent }) => emitDownloadProgress(loaded, total, percent),
        });
      }
    } catch (downloadErr: unknown) {
      const fail = asZipUrlDownloadFailure(downloadErr);
      if (fail.code >= 400 && fail.code < 600) {
        logger.debug('submission upload-from-url: download failed', { code: fail.code, error: fail.error });
        throw fail;
      }
      logger.debug('submission upload-from-url: download unexpected', { code: fail.code, error: fail.error });
      throw { error: fail.error, code: 400 };
    }

    if (uploadJobId && req.user?.id) {
      await jobProgressService
        .patchTrusted(uploadJobId, {
          phase: 'downloading_remote',
          percent: 100,
          message: 'Download complete',
          meta: {
            submissionId,
            source: 'upload_from_url',
            stage: 'download',
            downloadBytes: fileBuffer.length,
            downloadTotal: fileBuffer.length,
          },
        })
        .catch(() => undefined);
    }

    if (uploadJobId) {
      activeLevelZipFinalizeBySubmissionId.set(submissionId, uploadJobId);
      void (async () => {
        try {
          await finalizeSubmissionZipUploadFromBuffer({
            req,
            res: null,
            submissionId,
            expectedDirectDL,
            fileBuffer,
            encodedZipFileName,
            assembledFilePathToUnlink: null,
            uploadJobId,
            uploadJobMeta: { source: 'upload_from_url', stage: 'cdn' },
          });
        } catch (err) {
          logger.error('Async submission upload-from-url finalise failed', {
            submissionId,
            err,
          });
        } finally {
          activeLevelZipFinalizeBySubmissionId.delete(submissionId);
        }
      })();

      res.status(202).json({
        accepted: true,
        uploadJobId,
        submissionId,
        message: 'Processing started',
      });
      return;
    }

    activeLevelZipFinalizeBySubmissionId.set(submissionId, 'sync');
    try {
      await finalizeSubmissionZipUploadFromBuffer({
        req,
        res,
        submissionId,
        expectedDirectDL,
        fileBuffer,
        encodedZipFileName,
        assembledFilePathToUnlink: null,
        uploadJobId,
        uploadJobMeta: { source: 'upload_from_url', stage: 'cdn' },
      });
    } finally {
      activeLevelZipFinalizeBySubmissionId.delete(submissionId);
    }
  } catch (error: any) {
    const uploadJobIdErr = isUuidJobId(req.body?.uploadJobId) ? String(req.body.uploadJobId).trim() : undefined;
    if (uploadJobIdErr && req.user?.id && !res.headersSent) {
      const msg =
        typeof error?.error === 'string'
          ? error.error
          : error instanceof Error
            ? error.message
            : String(error);
      await jobProgressService
        .patchTrusted(uploadJobIdErr, {
          phase: 'failed',
          error: msg,
          message: msg,
          percent: null,
        })
        .catch(() => undefined);
    }
    sendSubmissionZipHandlerError(res, error, 'Failed to upload submission file from URL');
  }
}

export async function handlePostSubmissionSelectLevel(req: Request, res: Response): Promise<void> {
  try {
    const { selectedLevel } = req.body;
    const submissionId = parseSubmissionIdParam(req);
    if (!selectedLevel || typeof selectedLevel !== 'string' || selectedLevel.trim().length === 0) {
      throw { error: 'Missing selected level', code: 400 };
    }

    const submission = await LevelSubmission.findOne({
      where: { id: submissionId },
      include: [
        {
          model: LevelSubmissionSongRequest,
          as: 'songRequest',
          attributes: ['verificationState'],
          required: false,
        },
      ],
    });
    if (!submission) {
      throw { error: 'Submission not found', code: 404 };
    }
    await assertPendingSubmissionZipEditable(submissionId);

    if (!submission.directDL || !isWritableCdnUrl(submission.directDL)) {
      throw { error: 'Submission is not CDN-managed', code: 400 };
    }

    const fileId = fileIdFromSubmissionDirectDl(submission.directDL);
    if (!fileId) {
      throw { error: 'File ID is required', code: 400 };
    }

    const levelFiles = await cdnService.getLevelFiles(fileId);
    const selectedFile = matchLevelFileBySelection(
      levelFiles.map((file) => ({
        ...file,
        path: file.storagePath || file.fullPath,
        relativePath: file.relativePath || file.fullPath,
      })),
      selectedLevel,
    );

    if (!selectedFile) {
      logger.error('Selected level file not found for submission:', {
        fileId,
        selectedLevel,
        availableFiles: levelFiles.map((f) => f.fullPath || f.relativePath || f.name),
        submissionId,
      });
      throw {
        error: 'Selected level file not found',
        code: 400,
        details: {
          availableFiles: levelFiles.map((f) => f.fullPath || f.relativePath || f.name),
        },
      };
    }

    if (!selectedFile.hasYouTubeStream) {
      let songVerificationState: string | null | undefined;
      if (submission.songId != null) {
        const song = await Song.findByPk(submission.songId, { attributes: ['verificationState'] });
        songVerificationState = song?.verificationState;
      } else {
        songVerificationState = submission.songRequest?.verificationState;
      }
      if (isYsmodOnlyState(songVerificationState)) {
        throw {
          error: 'This song is YSMod-only: the selected chart must require the YouTubeStream mod',
          code: 400,
        };
      }
    }

    const resolvedSelection =
      selectedFile.relativePath ||
      selectedFile.fullPath ||
      selectedFile.storagePath ||
      selectedLevel;
    await cdnService.setTargetLevel(fileId, resolvedSelection);

    res.json({
      success: true,
      message: 'Level file selected successfully',
      selectedFile: {
        name: selectedFile.name,
        size: selectedFile.size,
        hasYouTubeStream: selectedFile.hasYouTubeStream,
        songFilename: selectedFile.songFilename,
        artist: selectedFile.artist,
        song: selectedFile.song,
        author: selectedFile.author,
        difficulty: selectedFile.difficulty,
        bpm: selectedFile.bpm,
      },
    });
  } catch (error: unknown) {
    sendSubmissionZipHandlerError(res, error, 'Failed to select level file');
  }
}

export async function handlePostSubmissionReparseChart(req: Request, res: Response): Promise<void> {
  try {
    const submissionId = parseSubmissionIdParam(req);
    const submission = await assertPendingSubmissionZipEditable(submissionId);

    if (!submission.directDL || !isCdnUrl(submission.directDL) || !isWritableCdnUrl(submission.directDL)) {
      throw { error: 'Submission is not CDN-managed', code: 400 };
    }

    const fileId = fileIdFromSubmissionDirectDl(submission.directDL);
    if (!fileId) {
      throw { error: 'File ID is required', code: 400 };
    }

    const chartStats = await cdnService.refreshLevelChartCacheAndGetStats(fileId);
    res.json({
      success: true,
      ...chartStats,
    });
  } catch (error: unknown) {
    sendSubmissionZipHandlerError(res, error, 'Failed to reparse chart');
  }
}
