import { Request, Response } from 'express';
import fs from 'fs';
import { randomUUID } from 'crypto';
import sequelize from '@/config/db.js';
import Level from '@/models/levels/Level.js';
import User from '@/models/auth/User.js';
import { logger } from '@/server/services/core/LoggerService.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import { applyLevelChartStatsFromCdn } from '@/misc/utils/data/levelChartStatsSync.js';
import { isCdnUrl } from '@/misc/utils/Utility.js';
import cdnService from '@/server/services/core/CdnService.js';
import { CDN_CONFIG } from '@/externalServices/cdnService/config.js';
import { jobProgressService, isUuidJobId } from '@/server/services/core/JobProgressService.js';
import UploadSession from '@/models/upload/UploadSession.js';
import { cancelSession as cancelUploadSession } from '@/server/services/upload/UploadSessionService.js';
import { permissionFlags } from '@/config/constants.js';
import { hasFlag } from '@/misc/utils/auth/permissionUtils.js';
import { tagAssignmentService } from '@/server/services/data/TagAssignmentService.js';
import { logLevelFileUploadHook, logLevelFileUpdateHook } from '@/server/routes/v2/webhooks/misc.js';
import { compareDurations, formatDurationMismatchMessage } from '@/server/domain/levels/levelZipDurationCompare.js';
import { normalizeLevelDlLinkSnapshot } from '@/server/domain/levels/levelDlLinkSnapshot.js';

const elasticsearchService = ElasticsearchService.getInstance();

const getUserModel = (user: any): User => user as User;

/**
 * Upload buffer to CDN, optional creator duration validation, short DB transaction, webhooks, cleanup.
 * Heavy work runs outside any DB transaction. `expectedDlLink` is a snapshot from authorisation time;
 * if the row's `dlLink` changed before commit, the new CDN object is removed and a 409 is thrown.
 * Pass `res: null` for fire-and-forget async jobs (HTTP 202); only job progress is updated then.
 */
export async function finalizeLevelZipUploadFromBuffer(params: {
  req: Request;
  res: Response | null;
  levelId: number;
  /** Normalised snapshot from the authorisation transaction (null = no link). */
  expectedDlLink: string | null;
  fileBuffer: Buffer;
  encodedZipFileName: string;
  assembledFilePathToUnlink: string | null;
  /** If set, the session row (and its workspace) is destroyed after successful finalisation. */
  uploadSession?: UploadSession | null;
  canEdit: boolean;
  uploadJobId?: string | null;
  /** Merged into job progress `meta` (e.g. `source: 'upload_from_url'`). */
  uploadJobMeta?: Record<string, unknown> | null;
}): Promise<void> {
  const {
    req,
    res,
    levelId,
    expectedDlLink,
    fileBuffer,
    encodedZipFileName,
    assembledFilePathToUnlink,
    uploadSession,
    canEdit,
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
    levelId,
    source: 'level_edit',
    ...(uploadJobMeta && typeof uploadJobMeta === 'object' ? uploadJobMeta : {}),
  };

  try {
    const levelSnapshot = await Level.findByPk(levelId);
    if (!levelSnapshot) {
      throw { error: 'Level not found', code: 404 };
    }

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
    const oldDlLink = levelSnapshot.dlLink;
    if (levelSnapshot.dlLink && isCdnUrl(levelSnapshot.dlLink)) {
      oldFileId = levelSnapshot.fileId ?? null;
      logger.debug('Found existing CDN file to clean up after upload', {
        levelId,
        oldFileId,
        oldDlLink: levelSnapshot.dlLink,
      });
    }

    const uploadResult = await cdnService.uploadLevelZip(fileBuffer, encodedZipFileName, uploadJobId || randomUUID());

    // Validate that chart gameplay hasn't changed by comparing durations
    if (!hasFlag(req.user, permissionFlags.SUPER_ADMIN) && canEdit && levelSnapshot.clears > 0) {
      try {
        let originalDurations: number[] | null = null;
        if (levelSnapshot.dlLink && isCdnUrl(levelSnapshot.dlLink)) {
          const originalFileId = levelSnapshot.fileId ?? null;
          if (originalFileId) {
            originalDurations = await cdnService.getDurationsFromFile(originalFileId);
          }
        }

        if (originalDurations) {
          const newDurations = await cdnService.getDurationsFromFile(uploadResult.fileId);

          if (!newDurations) {
            try {
              await cdnService.deleteFile(uploadResult.fileId);
            } catch (deleteError) {
              logger.error('Failed to delete uploaded file after duration extraction failure:', deleteError);
            }
            throw {
              error: 'Failed to extract durations from uploaded file',
              code: 500,
            };
          }

          logger.debug('Comparing durations - Original:', originalDurations.length, 'New:', newDurations.length);

          if (originalDurations.length !== newDurations.length) {
            try {
              await cdnService.deleteFile(uploadResult.fileId);
              logger.debug('Deleted uploaded file due to tile count mismatch', {
                fileId: uploadResult.fileId,
                levelId,
                originalTileCount: originalDurations.length,
                newTileCount: newDurations.length,
              });
            } catch (deleteError) {
              logger.error('Failed to delete uploaded file after tile count mismatch:', deleteError);
            }

            throw {
              error: `Chart tile count mismatch. Original chart has ${originalDurations.length} tiles, uploaded chart has ${newDurations.length} tiles.`,
              code: 400,
            };
          }

          const mismatchResult = compareDurations(originalDurations, newDurations);
          if (!mismatchResult.matches) {
            try {
              await cdnService.deleteFile(uploadResult.fileId);
              logger.debug('Deleted uploaded file due to duration mismatch', {
                fileId: uploadResult.fileId,
                levelId,
                mismatchCount: mismatchResult.mismatches.length,
                rangeCount: mismatchResult.ranges.length,
              });
            } catch (deleteError) {
              logger.error('Failed to delete uploaded file after validation failure:', deleteError);
            }

            const detailedMessage = formatDurationMismatchMessage(mismatchResult);

            throw {
              error:
                detailedMessage ||
                'Chart gameplay has changed. The timing/delays between inputs do not match the original chart.',
              code: 400,
            };
          }
        }
      } catch (validationError: any) {
        if (assembledFilePathToUnlink) {
          try {
            await fs.promises.unlink(assembledFilePathToUnlink);
          } catch (unlinkError: any) {
            if (unlinkError.code !== 'ENOENT') {
              logger.warn('Failed to clean up assembled file after validation failure:', unlinkError);
            }
          }
        }

        if (validationError.code === 400 || validationError.code === 500) {
          throw validationError;
        }
        logger.warn('Could not validate durations (original file may not exist):', {
          levelId,
          error: validationError instanceof Error ? validationError.message : String(validationError),
        });
      }
    }

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

    await sequelize.transaction(async (t) => {
      const fresh = await Level.findByPk(levelId, { transaction: t, lock: t.LOCK.UPDATE });
      if (!fresh) {
        throw { error: 'Level not found', code: 404 };
      }
      const currentSnap = normalizeLevelDlLinkSnapshot(fresh.dlLink);
      const expectedSnap = normalizeLevelDlLinkSnapshot(expectedDlLink);
      if (currentSnap !== expectedSnap) {
        try {
          await cdnService.deleteFile(uploadResult.fileId);
        } catch (delErr) {
          logger.warn('Failed to delete CDN file after dlLink conflict:', delErr);
        }
        throw {
          error:
            'This level was modified while the zip was processing (download link changed). Refresh the page and try again.',
          code: 409,
        };
      }
      fresh.dlLink = newDlUrl;
      await fresh.save({ transaction: t });
    });

    try {
      await applyLevelChartStatsFromCdn(levelId);
    } catch (chartSyncError) {
      logger.warn('Failed to sync chart BPM/tilecount after level upload:', {
        levelId,
        error: chartSyncError instanceof Error ? chartSyncError.message : String(chartSyncError),
      });
    }

    try {
      logger.debug('Logging webhook for level file upload', {
        levelId,
        oldDlLink,
        newPath: `${CDN_CONFIG.baseUrl}/${uploadResult.fileId}`,
      });
      const newPath = `${CDN_CONFIG.baseUrl}/${uploadResult.fileId}`;
      if (oldDlLink && typeof oldDlLink === 'string' && oldDlLink.length > 12) {
        await logLevelFileUpdateHook(oldDlLink, newPath, levelId, getUserModel(req.user));
      } else {
        await logLevelFileUploadHook(newPath, levelId, getUserModel(req.user));
      }
    } catch (webhookError) {
      logger.warn('Failed to send webhook for level file upload:', webhookError);
    }

    if (oldFileId) {
      try {
        logger.debug('Cleaning up old CDN file after successful upload', {
          levelId,
          oldFileId,
          newFileId: uploadResult.fileId,
        });
        await cdnService.deleteFile(oldFileId);
        logger.debug('Successfully cleaned up old CDN file', {
          levelId,
          oldFileId,
        });
      } catch (cleanupError) {
        logger.error('Failed to clean up old CDN file after successful upload:', {
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          levelId,
          oldFileId,
          newFileId: uploadResult.fileId,
        });
      }
    }

    try {
      const tagResult = await tagAssignmentService.refreshAutoTags(levelId);
      if (tagResult.assignedTags.length > 0 || tagResult.removedTags.length > 0) {
        logger.debug('Auto tags refreshed after level upload', {
          levelId,
          assignedTags: tagResult.assignedTags,
          removedTags: tagResult.removedTags,
        });
        await elasticsearchService.reindexLevels([levelId]);
      }
    } catch (tagError) {
      logger.warn('Failed to refresh auto tags after level upload:', {
        levelId,
        error: tagError instanceof Error ? tagError.message : String(tagError),
      });
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
      logger.warn('Response already sent or ended. Upload succeeded but response not sent.', {
        levelId,
        fileId: uploadResult.fileId,
        userId: req.user?.id,
      });
      return;
    }

    try {
      const levelAfter = await Level.findByPk(levelId);
      res.json({
        success: true,
        level: levelAfter,
        levelFiles,
      });
    } catch (writeError: any) {
      if (
        writeError.code === 'ECONNRESET' ||
        writeError.code === 'EPIPE' ||
        writeError.message?.includes('write after end')
      ) {
        logger.warn('Failed to send response - client may have disconnected. Upload succeeded.', {
          levelId,
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
