import fs from 'fs';
import { Request, Response } from 'express';
import sequelize from '@/config/db.js';
import Level from '@/models/levels/Level.js';
import User from '@/models/auth/User.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { isCdnUrl, safeTransactionRollback } from '@/misc/utils/Utility.js';
import cdnService from '@/server/services/core/CdnService.js';
import { jobProgressService, isUuidJobId } from '@/server/services/core/JobProgressService.js';
import UploadSession from '@/models/upload/UploadSession.js';
import {
  cancelSession as cancelUploadSession,
  destroySession,
} from '@/server/services/upload/UploadSessionService.js';
import { permissionFlags } from '@/config/constants.js';
import { hasFlag } from '@/misc/utils/auth/permissionUtils.js';
import { logLevelTargetUpdateHook, logLevelFileDeleteHook } from '@/server/routes/v2/webhooks/misc.js';
import { asZipUrlDownloadFailure, downloadZipFromUrl, isValidHttpUrl } from '@/misc/utils/data/levelZipFromUrl.js';
import { applyLevelChartStatsFromCdn } from '@/misc/utils/data/levelChartStatsSync.js';
import { checkLevelOwnership } from '@/server/domain/levels/levelOwnership.js';
import { normalizeLevelDlLinkSnapshot } from '@/server/domain/levels/levelDlLinkSnapshot.js';
import { encodeLevelZipFilenameForCdn } from '@/server/domain/levels/levelZipFilename.js';
import { finalizeLevelZipUploadFromBuffer } from '@/server/domain/levels/levelZipFinalize.js';
import {
  isAssembledZipMissingError,
  readAssembledLevelZipFromPath,
} from '@/server/domain/levels/levelZipUploadRead.js';
import { activeLevelZipFinalizeByLevelId } from '@/server/domain/levels/levelZipUploadConcurrency.js';

const getUserModel = (user: any): User => user as User;

/** Chunked session zip only (`sessionId`); optional `uploadJobId` for async job progress. */
export async function handlePostLevelZipUpload(req: Request, res: Response): Promise<void> {
  let uploadSession: UploadSession | null = null;
  let assembledFilePath = '';
  let encodedZipFileName = '';

  try {
    const { sessionId, uploadJobId: rawUploadJobId } = req.body;
    const uploadJobId = isUuidJobId(rawUploadJobId) ? rawUploadJobId.trim() : undefined;
    const levelId = parseInt(req.params.id, 10);

    if (!sessionId || typeof sessionId !== 'string') {
      throw { error: 'Missing sessionId', code: 400 };
    }

    const { expectedDlLink, canEdit } = await sequelize.transaction(async (t) => {
      uploadSession = await UploadSession.findByPk(sessionId, { transaction: t });
      if (!uploadSession) throw { error: 'Upload session not found', code: 404 };
      if (uploadSession.userId !== req.user?.id) throw { error: 'Forbidden', code: 403 };
      if (uploadSession.kind !== 'level-zip') {
        throw { error: 'Upload session is not for a level zip', code: 400 };
      }
      if (uploadSession.status !== 'assembled' || !uploadSession.assembledPath) {
        throw { error: 'Upload session has no assembled file yet', code: 409 };
      }
      assembledFilePath = uploadSession.assembledPath;
      encodedZipFileName = uploadSession.originalName;

      const level = await Level.findByPk(levelId, { transaction: t, lock: t.LOCK.UPDATE });
      if (!level) {
        throw { error: 'Level not found', code: 404 };
      }

      const own = await checkLevelOwnership(levelId, req.user, t);
      if (!own.canEdit) {
        throw { error: own.errorMessage || 'Forbidden', code: 403 };
      }

      return {
        expectedDlLink: normalizeLevelDlLinkSnapshot(level.dlLink),
        canEdit: own.canEdit,
      };
    });

    try {
      await fs.promises.access(assembledFilePath, fs.constants.R_OK);
    } catch {
      logger.warn('Level zip upload: session marked assembled but assembled file is missing; invalidating session', {
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

    if (activeLevelZipFinalizeByLevelId.has(levelId)) {
      throw {
        error: 'Another zip upload is already processing for this level. Wait for it to finish.',
        code: 409,
      };
    }

    const runFinalizeOnce = async (response: Response | null, preloadedZipBuffer?: Buffer) => {
      const fileBuffer =
        preloadedZipBuffer ?? (await readAssembledLevelZipFromPath(assembledFilePath));

      await finalizeLevelZipUploadFromBuffer({
        req,
        res: response,
        levelId,
        expectedDlLink,
        fileBuffer,
        encodedZipFileName,
        assembledFilePathToUnlink: null,
        chunkUploadFileIdForCleanupExclude: null,
        uploadSession,
        canEdit,
        uploadJobId,
      });
    };

    if (uploadJobId) {
      activeLevelZipFinalizeByLevelId.set(levelId, uploadJobId);
      if (req.user?.id) {
        await jobProgressService
          .patchTrusted(uploadJobId, {
            ownerUserId: req.user.id,
            kind: 'level_upload',
            phase: 'queued',
            percent: 0,
            message: 'Reading assembled zip…',
            meta: { levelId, source: 'level_edit', stage: 'prepare' },
          })
          .catch(() => undefined);
      }

      let zipSnapshot: Buffer;
      try {
        zipSnapshot = await readAssembledLevelZipFromPath(assembledFilePath);
      } catch (readErr) {
        activeLevelZipFinalizeByLevelId.delete(levelId);
        const missing = isAssembledZipMissingError(readErr);
        if (missing && uploadSession) {
          try {
            await destroySession(uploadSession);
          } catch (destroyErr) {
            logger.warn('Failed to destroy session after missing assembled file:', destroyErr);
          }
        }
        await jobProgressService
          .patchTrusted(uploadJobId, {
            phase: 'failed',
            error: readErr instanceof Error ? readErr.message : String(readErr),
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
          logger.error('Async level zip finalise failed', {
            levelId,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          activeLevelZipFinalizeByLevelId.delete(levelId);
        }
      })();

      res.status(202).json({
        accepted: true,
        uploadJobId,
        levelId,
        message: 'Processing started',
      });
      return;
    }

    activeLevelZipFinalizeByLevelId.set(levelId, 'sync');
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
      activeLevelZipFinalizeByLevelId.delete(levelId);
    }
  } catch (error: any) {
    if (error instanceof Error && error.message.includes('Client disconnected')) {
      logger.warn('Client disconnected during level file upload:', {
        levelId: req.params.id,
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

    let statusCode =
      typeof error?.code === 'number' && error.code >= 100 && error.code < 600 ? error.code : 500;
    if (statusCode === 500 && isAssembledZipMissingError(error)) {
      statusCode = 409;
    }
    const body =
      typeof error?.error === 'string'
        ? error
        : { error: error instanceof Error ? error.message : String(error), code: statusCode };
    if (statusCode === 500) logger.error('Error uploading level file:', error);
    res.status(statusCode).json(body);
  }
}

export async function handlePostLevelZipUploadFromUrl(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user || !hasFlag(req.user, permissionFlags.SUPER_ADMIN)) {
      throw { error: 'Forbidden', code: 403 };
    }

    const { url, uploadJobId: rawUploadJobId } = req.body;
    const uploadJobId = isUuidJobId(rawUploadJobId) ? rawUploadJobId.trim() : undefined;
    const levelId = parseInt(req.params.id, 10);
    if (!url || typeof url !== 'string') {
      throw { error: 'Missing url', code: 400 };
    }
    const trimmed = url.trim();
    if (!trimmed) {
      throw { error: 'Missing url', code: 400 };
    }
    if (!isValidHttpUrl(trimmed)) {
      throw { error: 'Invalid download URL', code: 400 };
    }
    if (isCdnUrl(trimmed)) {
      throw { error: 'URL must not point to the site CDN', code: 400 };
    }

    const { expectedDlLink, canEdit, encodedZipFileName } = await sequelize.transaction(async (t) => {
      const level = await Level.findByPk(levelId, { transaction: t, lock: t.LOCK.UPDATE });
      if (!level) {
        throw { error: 'Level not found', code: 404 };
      }
      const own = await checkLevelOwnership(levelId, req.user, t);
      if (!own.canEdit) {
        throw { error: own.errorMessage || 'Forbidden', code: 403 };
      }
      return {
        expectedDlLink: normalizeLevelDlLinkSnapshot(level.dlLink),
        canEdit: own.canEdit,
        encodedZipFileName: encodeLevelZipFilenameForCdn(level),
      };
    });

    if (activeLevelZipFinalizeByLevelId.has(levelId)) {
      throw {
        error: 'Another zip upload is already processing for this level. Wait for it to finish.',
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
          message: 'Starting download',
          meta: { levelId, source: 'upload_from_url', stage: 'download' },
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
            levelId,
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
      fileBuffer = await downloadZipFromUrl(trimmed, {
        onProgress: ({ loaded, total, percent }) => emitDownloadProgress(loaded, total, percent),
      });
    } catch (downloadErr: unknown) {
      const fail = asZipUrlDownloadFailure(downloadErr);
      if (fail.code >= 400 && fail.code < 600) {
        logger.debug('upload-from-url: download failed', { code: fail.code, error: fail.error });
        throw fail;
      }
      logger.debug('upload-from-url: download unexpected', { code: fail.code, error: fail.error });
      throw { error: fail.error, code: 400 };
    }

    if (uploadJobId && req.user?.id) {
      await jobProgressService
        .patchTrusted(uploadJobId, {
          phase: 'downloading_remote',
          percent: 100,
          message: 'Download complete',
          meta: {
            levelId,
            source: 'upload_from_url',
            stage: 'download',
            downloadBytes: fileBuffer.length,
            downloadTotal: fileBuffer.length,
          },
        })
        .catch(() => undefined);
    }

    if (uploadJobId) {
      activeLevelZipFinalizeByLevelId.set(levelId, uploadJobId);
      void (async () => {
        try {
          await finalizeLevelZipUploadFromBuffer({
            req,
            res: null,
            levelId,
            expectedDlLink,
            fileBuffer,
            encodedZipFileName,
            assembledFilePathToUnlink: null,
            chunkUploadFileIdForCleanupExclude: null,
            canEdit,
            uploadJobId,
            uploadJobMeta: { source: 'upload_from_url', stage: 'cdn' },
          });
        } catch (err) {
          logger.error('Async upload-from-url finalise failed', {
            levelId,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          activeLevelZipFinalizeByLevelId.delete(levelId);
        }
      })();

      res.status(202).json({
        accepted: true,
        uploadJobId,
        levelId,
        message: 'Processing started',
      });
      return;
    }

    activeLevelZipFinalizeByLevelId.set(levelId, 'sync');
    try {
      await finalizeLevelZipUploadFromBuffer({
        req,
        res,
        levelId,
        expectedDlLink,
        fileBuffer,
        encodedZipFileName,
        assembledFilePathToUnlink: null,
        chunkUploadFileIdForCleanupExclude: null,
        canEdit,
        uploadJobId,
        uploadJobMeta: { source: 'upload_from_url', stage: 'cdn' },
      });
    } finally {
      activeLevelZipFinalizeByLevelId.delete(levelId);
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
          percent: null,
        })
        .catch(() => undefined);
    }
    const statusCode =
      typeof error.code === 'number' && error.code >= 100 && error.code < 600 ? error.code : 500;
    if (statusCode === 500) logger.error('Error uploading level file from URL:', error);
    res.status(statusCode).json(error);
  }
}

export async function handlePostLevelSelectLevel(req: Request, res: Response): Promise<void> {
  let transaction: any;

  try {
    transaction = await sequelize.transaction();
    const { selectedLevel } = req.body;
    const levelId = parseInt(req.params.id, 10);
    if (!selectedLevel) {
      throw { error: 'Missing selected level', code: 400 };
    }

    const level = await Level.findByPk(levelId, { transaction });
    if (!level) {
      throw { error: 'Level not found', code: 404 };
    }

    const { canEdit, errorMessage } = await checkLevelOwnership(levelId, req.user, transaction);

    if (!canEdit) {
      throw { error: errorMessage, code: 403 };
    }

    const fileId = level.fileId ?? null;
    if (!fileId) {
      throw { error: 'File ID is required', code: 400 };
    }

    const file = await cdnService.setTargetLevel(fileId, selectedLevel);
    if (!file) {
      throw { error: 'File not found', code: 404 };
    }

    await transaction.commit();

    try {
      await applyLevelChartStatsFromCdn(levelId);
    } catch (chartSyncError) {
      logger.warn('Failed to sync chart BPM/tilecount after target level change:', {
        levelId,
        error: chartSyncError instanceof Error ? chartSyncError.message : String(chartSyncError),
      });
    }

    try {
      await logLevelTargetUpdateHook(selectedLevel.toString(), levelId, getUserModel(req.user));
    } catch (webhookError) {
      logger.warn('Failed to send webhook for level target update:', webhookError);
    }

    res.json({
      success: true,
      message: 'Level file selected successfully',
    });
  } catch (error: any) {
    await safeTransactionRollback(transaction);
    const statusCode =
      typeof error.code === 'number' && error.code >= 100 && error.code < 600 ? error.code : 500;
    if (statusCode === 500) logger.error('Error selecting level file:', error);
    res.status(statusCode).json(error);
  }
}

export async function handleDeleteLevelZipUpload(req: Request, res: Response): Promise<void> {
  let transaction: any;

  try {
    transaction = await sequelize.transaction();
    const levelId = parseInt(req.params.id, 10);

    const level = await Level.findByPk(levelId, { transaction });
    if (!level) {
      throw { error: 'Level not found', code: 404 };
    }

    const { canEdit, errorMessage } = await checkLevelOwnership(levelId, req.user, transaction);

    if (!canEdit) {
      throw { error: errorMessage, code: 403 };
    }

    if (level.clears > 0 && !hasFlag(req.user, permissionFlags.SUPER_ADMIN)) {
      throw {
        error: 'You cannot delete a level with clears, request it in the discord server.',
        code: 400,
      };
    }

    if (!level.dlLink || !isCdnUrl(level.dlLink)) {
      throw { error: 'Level does not have a CDN-managed file', code: 400 };
    }

    const fileId = level.fileId!;
    if (!fileId) {
      throw { error: 'Level does not have a CDN-managed file', code: 400 };
    }
    logger.debug(`Deleting file from CDN: ${fileId}`);
    await cdnService.deleteFile(fileId);

    await Level.update(
      {
        dlLink: 'removed',
        bpm: null,
        tilecount: null,
        levelLengthInMs: null,
      },
      {
        where: { id: levelId },
        transaction,
      },
    );

    await transaction.commit();

    try {
      await logLevelFileDeleteHook(levelId, getUserModel(req.user));
    } catch (webhookError) {
      logger.warn('Failed to send webhook for level file delete:', webhookError);
    }

    res.json({
      success: true,
      dlLink: 'removed',
      message: 'Level file deleted successfully',
    });
  } catch (error: any) {
    await safeTransactionRollback(transaction);
    const statusCode =
      typeof error.code === 'number' && error.code >= 100 && error.code < 600 ? error.code : 500;
    if (statusCode === 500) logger.error('Error deleting level file:', error);
    res.status(statusCode).json(error);
  }
}
