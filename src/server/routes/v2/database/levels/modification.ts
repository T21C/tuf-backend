import {Router, Request, Response} from 'express';
import sequelize from '@/config/db.js';
import Level from '@/models/levels/Level.js';
import Difficulty from '@/models/levels/Difficulty.js';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import { standardErrorResponses, standardErrorResponses403404500, standardErrorResponses404500, standardErrorResponses500, idParamSpec, errorResponseSchema } from '@/server/schemas/v2/database/levels/index.js';
import {Transaction} from 'sequelize';
import Rating from '@/models/levels/Rating.js';
import Pass from '@/models/passes/Pass.js';
import Judgement from '@/models/passes/Judgement.js';
import {calcAcc} from '@/misc/utils/pass/CalcAcc.js';
import {getScoreV2} from '@/misc/utils/pass/CalcScore.js';
import {PlayerStatsService} from '@/server/services/core/PlayerStatsService.js';
import {sseManager} from '@/misc/utils/server/sse.js';
import LevelLikes from '@/models/levels/LevelLikes.js';
import User from '@/models/auth/User.js';
import { CacheInvalidation } from '@/server/middleware/cache.js';

// Type assertion helper for req.user to User model
const getUserModel = (user: any): User => user as User;
import Player from '@/models/players/Player.js';
import {logger} from '@/server/services/core/LoggerService.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import { applyLevelChartStatsFromCdn } from '@/misc/utils/data/levelChartStatsSync.js';
import {
  isCdnUrl,
  safeTransactionRollback,
  sanitizeTextInput,
} from '@/misc/utils/Utility.js';
import cdnService from '@/server/services/core/CdnService.js';
import {CDN_CONFIG} from '@/externalServices/cdnService/config.js';
import { jobProgressService, isUuidJobId } from '@/server/services/core/JobProgressService.js';
import fs from 'fs';
import path from 'path';
import {cleanupUserUploads} from '@/server/routes/v2/misc/chunkedUpload.js';
import UploadSession from '@/models/upload/UploadSession.js';
import { cancelSession as cancelUploadSession } from '@/server/services/upload/UploadSessionService.js';
import LevelRerateHistory from '@/models/levels/LevelRerateHistory.js';
import LevelTag from '@/models/levels/LevelTag.js';
import {permissionFlags} from '@/config/constants.js';
import {hasFlag} from '@/misc/utils/auth/permissionUtils.js';
import {tagAssignmentService} from '@/server/services/data/TagAssignmentService.js';
import LevelCredit, { CreditRole } from '@/models/levels/LevelCredit.js';
import {
  logLevelFileUploadHook,
  logLevelFileUpdateHook,
  logLevelFileDeleteHook,
  logLevelTargetUpdateHook,
  logLevelMetadataUpdateHook,
} from '@/server/routes/v2/webhooks/misc.js';
import LevelTagAssignment from '@/models/levels/LevelTagAssignment.js';
import { getSongDisplayName, getArtistDisplayName } from '@/misc/utils/data/levelHelpers.js';
import {asZipUrlDownloadFailure, downloadZipFromUrl, isValidHttpUrl} from '@/misc/utils/data/levelZipFromUrl.js';
import Song from '@/models/songs/Song.js';
import Artist from '@/models/artists/Artist.js';
const playerStatsService = PlayerStatsService.getInstance();
const elasticsearchService = ElasticsearchService.getInstance();

/** Prevents overlapping zip finalisation for the same level (HTTP 202 async + sync uploads). */
const activeLevelZipFinalizeByLevelId = new Map<number, string>();

function normalizeLevelDlLinkSnapshot(value: string | null | undefined): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

/**
 * Compare two duration arrays with a tolerance of ~0.5ms
 * Returns mismatch information including indices and ranges
 */
interface DurationMismatchResult {
  matches: boolean;
  mismatches: number[];
  ranges: Array<{ start: number; end: number }>;
}

function compareDurations(originalDurations: number[], newDurations: number[]): DurationMismatchResult {
  const result: DurationMismatchResult = {
    matches: true,
    mismatches: [],
    ranges: []
  };

  if (originalDurations.length !== newDurations.length) {
    result.matches = false;
    return result;
  }

  const tolerance = 0.5; // ms

  // Find all mismatches
  for (let i = 0; i < originalDurations.length; i++) {
    const diff = Math.abs(originalDurations[i] - newDurations[i]);
    if (diff > tolerance) {
      result.matches = false;
      result.mismatches.push(i);
    }
  }

  // Group consecutive mismatches into ranges
  if (result.mismatches.length > 0) {
    let rangeStart = result.mismatches[0];
    let rangeEnd = result.mismatches[0];

    for (let i = 1; i < result.mismatches.length; i++) {
      if (result.mismatches[i] === rangeEnd + 1) {
        // Consecutive, extend range
        rangeEnd = result.mismatches[i];
      } else {
        // Gap found, save current range and start new one
        result.ranges.push({ start: rangeStart, end: rangeEnd });
        rangeStart = result.mismatches[i];
        rangeEnd = result.mismatches[i];
      }
    }
    // Add the last range
    result.ranges.push({ start: rangeStart, end: rangeEnd });
  }

  return result;
}

/**
 * Format duration mismatch message for user feedback
 */
function formatDurationMismatchMessage(mismatchResult: DurationMismatchResult): string {
  if (mismatchResult.matches) {
    return '';
  }

  const { mismatches, ranges } = mismatchResult;

  // If there are less than 5 singular mismatches (no consecutive ranges), list them directly
  if (mismatches.length < 5 && ranges.length === mismatches.length) {
    // All mismatches are singular (no consecutive tiles)
    const tileNumbers = mismatches.map(index => index + 1).join(', '); // Convert to 1-based tile numbers
    return `Tiles ${tileNumbers} have different timing than original`;
  }

  // If there are ranges, format up to 3 ranges
  const displayRanges = ranges.slice(0, 3);
  const remainingRanges = ranges.length - 3;
  const remainingMismatches = remainingRanges > 0
    ? ranges.slice(3).reduce((sum, range) => sum + (range.end - range.start + 1), 0)
    : 0;

  const rangeStrings = displayRanges.map(range => {
    if (range.start === range.end) {
      return `Tile ${range.start + 1}`; // Single tile, convert to 1-based
    } else {
      return `Tiles ${range.start + 1}-${range.end + 1}`; // Range, convert to 1-based
    }
  });

  let message = rangeStrings.join(', ');

  if (remainingRanges > 0) {
    message += `, and ${remainingMismatches} more tile${remainingMismatches !== 1 ? 's' : ''}`;
  }

  return `${message} have different timing than original`;
}

/** Build an NFC-normalised UTF-8 zip filename for CDN upload (no hex hack). */
function encodeLevelZipFilenameForCdn(level: Level): string {
  const song = getSongDisplayName(level) || 'level';
  const artist = getArtistDisplayName(level) || 'unknown';
  const base = `${song} - ${artist}.zip`.replace(/[<>:"/\\|?*]/g, '');
  return base.normalize('NFC');
}

/**
 * Upload buffer to CDN, optional creator duration validation, short DB transaction, webhooks, cleanup.
 * Heavy work runs outside any DB transaction. `expectedDlLink` is a snapshot from authorisation time;
 * if the row's `dlLink` changed before commit, the new CDN object is removed and a 409 is thrown.
 * Pass `res: null` for fire-and-forget async jobs (HTTP 202); only job progress is updated then.
 */
async function finalizeLevelZipUploadFromBuffer(params: {
  req: Request;
  res: Response | null;
  levelId: number;
  /** Normalised snapshot from the authorisation transaction (null = no link). */
  expectedDlLink: string | null;
  fileBuffer: Buffer;
  encodedZipFileName: string;
  assembledFilePathToUnlink: string | null;
  chunkUploadFileIdForCleanupExclude: string | null;
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
    chunkUploadFileIdForCleanupExclude,
    uploadSession,
    canEdit,
    uploadJobMeta,
  } = params;

  const uploadJobId =
    params.uploadJobId != null && isUuidJobId(params.uploadJobId)
      ? params.uploadJobId.trim()
      : undefined;

  const markJobFailed = async (message: string) => {
    if (!uploadJobId || !req.user?.id) {
      return;
    }
    await jobProgressService.patchTrusted(uploadJobId, {
      phase: 'failed',
      error: message,
      percent: null
    }).catch(() => undefined);
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
      await jobProgressService.patchTrusted(uploadJobId, {
        ownerUserId: req.user.id,
        kind: 'level_upload',
        phase: 'uploading_to_cdn',
        percent: 5,
        message: 'Sending zip to CDN',
        meta: jobMetaBase,
      }).catch(() => undefined);
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

    const uploadResult = await cdnService.uploadLevelZip(
      fileBuffer,
      encodedZipFileName,
      uploadJobId
    );

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
        logger.error(
          'Failed to clean up old CDN file after successful upload:',
          {
            error:
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError),
            levelId,
            oldFileId,
            newFileId: uploadResult.fileId,
          },
        );
      }
    }

    try {
      await cleanupUserUploads(req.user!.id, chunkUploadFileIdForCleanupExclude || undefined);
    } catch (cleanupError) {
      logger.warn(
        'Failed to clean up user uploads after successful processing:',
        cleanupError,
      );
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
      await jobProgressService.patchTrusted(uploadJobId, {
        phase: 'completed',
        percent: 100,
        message: 'Upload complete',
        newFileId: uploadResult.fileId,
        meta: {...jobMetaBase, newFileId: uploadResult.fileId},
      }).catch(() => undefined);
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
        typeof err?.error === 'string'
          ? err.error
          : err instanceof Error
            ? err.message
            : String(err);
      await markJobFailed(msg);
    }
    throw err;
  }
}

const router = Router();

// Shared function to check if user has permission to modify a level
export interface OwnershipCheckResult {
  canEdit: boolean;
  errorMessage?: string;
}

export const checkLevelOwnership = async (
  levelId: number,
  user: any,
  transaction: Transaction,
): Promise<OwnershipCheckResult> => {
  const isSuperAdmin = user && hasFlag(user, permissionFlags.SUPER_ADMIN);
  let isCreator = false;
  let charterCount = 0;
  let isOwner = false;

  if (!isSuperAdmin && user?.creatorId) {
    // Check if user is a creator of this level
    const levelCredits = await LevelCredit.findAll({
      where: {levelId},
      transaction,
    });

    // Count CHARTER roles
    charterCount = levelCredits.filter(
      credit => credit.role?.toLowerCase() === CreditRole.CHARTER
    ).length;

    // Check if user is one of the creators
    isCreator = levelCredits.some(
      credit => credit.creatorId === user.creatorId &&
      credit.role?.toLowerCase() === CreditRole.CHARTER
    );

    isOwner = levelCredits.some(
      credit => credit.creatorId === user.creatorId && credit.isOwner
    );
  }

  let canEdit = false;
  let errorMessage: string | undefined;
  if (isSuperAdmin || isOwner) {
    canEdit = true;
  } else if (isCreator && charterCount <= 2) {
    canEdit = true;
  } else if (isCreator && charterCount > 2) {
    canEdit = false;
    errorMessage = '(>2 CHARTERS) You must be the owner of this level to edit it. Contact admins if you believe that you should be the owner.';
  } else {
    canEdit = false;
    errorMessage = 'You are not authorized to edit this level';
  }
  return {canEdit, errorMessage};
};

// Helper functions for level updates
const handleRatingChanges = async (
  level: Level,
  req: Request,
  transaction: Transaction,
) => {
  if (
    typeof req.body.toRate === 'boolean' &&
    req.body.toRate !== level.toRate
  ) {
    if (req.body.toRate) {
      // Create new rating if toRate is being set to true
      const existingRating = await Rating.findOne({
        where: {
          levelId: level.id,
          confirmedAt: null,
        },
        transaction,
      });

      if (!existingRating) {
        const lowDiff = req.body.rerateNum
          ? /^[pP]\d/.test(req.body.rerateNum)
          : false;

        await Rating.create(
          {
            levelId: level.id,
            lowDiff,
            requesterFR: '',
            averageDifficultyId: null,
            communityDifficultyId: null,
            confirmedAt: null,
          },
          {transaction},
        );
      }
    } else {
      const existingRating = await Rating.findOne({
        where: {
          levelId: level.id,
          confirmedAt: null,
        },
        transaction,
      });

      if (existingRating) {
        await existingRating.update(
          {
            confirmedAt: new Date(),
            requesterFR: req.body.rerateNum || level.rerateNum || existingRating.requesterFR,
          },
          {transaction},
        );
      }
    }
  }
};

const handleLowDiffFlag = async (
  level: Level,
  req: Request,
  transaction: Transaction,
) => {
  const existingRating = await Rating.findOne({
    where: {
      levelId: level.id,
      confirmedAt: null,
    },
    transaction,
  });

  if (existingRating) {
    const lowDiff =
      /^[pP]\d/.test(req.body.rerateNum) ||
      /^[pP]\d/.test(existingRating.dataValues.requesterFR);
    await existingRating.update({lowDiff}, {transaction});
  }
};

const handleFlagChanges = (level: Level, req: Request) => {
  let isDeleted = level.isDeleted;
  let isHidden = level.isHidden;
  let isAnnounced = level.isAnnounced;

  if (req.body.isDeleted === true) {
    isDeleted = true;
    isHidden = true;
  } else if (req.body.isDeleted === false) {
    isDeleted = false;
    isHidden = false;
  } else if (req.body.isHidden !== undefined) {
    isHidden = req.body.isHidden;
  }

  // `isAnnounced` must only change from toRate transitions (rerate workflow). Do not read
  // `req.body.isAnnounced`: clients (e.g. edit popup) often send a stale default `false` on
  // every save, which would clear the flag after Discord announcements.
  if (req.body.toRate === true && level.toRate === false) {
    isAnnounced = true;
  } else if (req.body.toRate === false && level.toRate === true) {
    const hasRunningChanges =
      level.diffId !== (req.body.diffId ?? level.diffId ?? 0) ||
      level.baseScore !== (req.body.baseScore ?? level.baseScore ?? 0);
    const hasFrozenChanges =
      level.diffId !== level.previousDiffId ||
      level.baseScore !== level.previousBaseScore;

    const hasChanges = hasRunningChanges || hasFrozenChanges;
    isAnnounced = !hasChanges;
  }

  return {isDeleted, isHidden, isAnnounced};
};

const handleScoreRecalculations = async (
  levelId: number,
  updateData: any,
  transaction: Transaction,
): Promise<number[]> => {
  const passes = await Pass.findAll({
    where: {levelId},
    include: [
      {
        model: Judgement,
        as: 'judgements',
      },
    ],
    transaction,
  });

  // Get the difficulty once for all passes
  const currentDifficulty = await Difficulty.findByPk(
    updateData.diffId,
    {transaction}
  );

  if (!currentDifficulty) {
    logger.error(
      `No difficulty found for level ${levelId} with diffId ${updateData.diffId}`,
    );
    return [];
  }

  // Collect all updates for bulk operation
  const passUpdates: Array<{id: number; levelId: number; playerId: number; accuracy: number; scoreV2: number}> = [];

  for (const passData of passes) {
    const pass = passData.dataValues;
    if (!pass.judgements) continue;

    const accuracy = calcAcc(pass.judgements);
    const diffToUse = currentDifficulty || pass.level?.difficulty;

    if (!diffToUse) {
      logger.warn(`No difficulty found for pass ${pass.id}, skipping score calculation`);
      continue;
    }

    const levelData = {
      baseScore: updateData.baseScore || pass.level?.baseScore || 0,
      ppBaseScore: updateData.ppBaseScore || pass.level?.ppBaseScore || 0,
      difficulty: {
        name: diffToUse.name,
        baseScore: diffToUse.baseScore || 0,
      },
    };

    const scoreV2 = getScoreV2(
      {
        speed: pass.speed || 1,
        judgements: pass.judgements,
        isNoHoldTap: pass.isNoHoldTap || false,
      },
      levelData,
    );

    logger.debug(`Pass ${pass.id} scoreV2: ${scoreV2}`);
    passUpdates.push({
      id: pass.id,
      levelId: pass.levelId,
      playerId: pass.playerId,
      accuracy,
      scoreV2,
    });
  }

  // Perform bulk update if there are any updates
  if (passUpdates.length > 0) {
    // Update each pass using a bulk update query
    await Pass.bulkCreate(
      passUpdates,
      {
        updateOnDuplicate: ['accuracy', 'scoreV2'],
        transaction,
      },
    );
    await elasticsearchService.reindexPasses(passUpdates.map(pass => pass.id));

    logger.debug(`Bulk updated ${passUpdates.length} passes for level ${levelId}`);
  }

  return passes.map(pass => pass.playerId);
};

router.put(
  '/own/:id([0-9]{1,20})',
  Auth.verified(),
  ApiDoc({
    operationId: 'putLevelOwn',
    summary: 'Update own level',
    description: 'Update level metadata (song, artist, links, etc.) when user owns the level.',
    tags: ['Database', 'Levels'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    requestBody: { description: 'song, artist, videoLink, dlLink, suffix, workshopLink, songId', schema: { type: 'object' }, required: true },
    responses: { 200: { description: 'Level updated' }, ...standardErrorResponses403404500 },
  }),
  async (req: Request, res: Response) => {
  let transaction: any;
  try {
    transaction = await sequelize.transaction();
    const levelId = parseInt(req.params.id);
    const {canEdit, errorMessage} = await checkLevelOwnership(
      levelId,
      req.user,
      transaction,
    );
    if (!canEdit && req.user) {
      await safeTransactionRollback(transaction);
      return res.status(403).json({error: errorMessage});
    }
    const level = await Level.findByPk(levelId, {transaction});
    if (!level) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({error: 'Level not found'});
    }
    const oldLevel = {...level.dataValues} as Level;

    const updateData: any = {};
    if (req.body.song !== undefined) updateData.song = sanitizeTextInput(req.body.song);
    if (req.body.artist !== undefined) updateData.artist = sanitizeTextInput(req.body.artist);
    if (req.body.videoLink !== undefined) updateData.videoLink = sanitizeTextInput(req.body.videoLink);
    if (req.body.dlLink !== undefined) updateData.dlLink = sanitizeTextInput(req.body.dlLink);

    // Handle suffix
    if (req.body.suffix !== undefined) {
      updateData.suffix = req.body.suffix && typeof req.body.suffix === 'string'
        ? req.body.suffix.trim() || null
        : null;
    }

    if (req.body.workshopLink !== undefined) updateData.workshopLink = sanitizeTextInput(req.body.workshopLink);

    if (
      canEdit
      && level.clears > 0
      && level.dlLink
      && !isCdnUrl(level.dlLink)
      || isCdnUrl(req.body.dlLink)
      ) {
        updateData.dlLink = undefined;
      }

    // Handle songId if provided (for normalized song relationships)
    if (req.body.songId !== undefined) {
      if (req.body.songId === null || req.body.songId === '') {
        updateData.songId = null;
      } else {
        const songId = parseInt(req.body.songId);
        if (!isNaN(songId) && songId > 0) {
          const song = await Song.findByPk(songId, {transaction, include: [
            {
              model: Artist,
              as: 'artists',
              required: false,
            },
          ]});
          if (song) {
            const suffix = updateData.suffix !== undefined ? updateData.suffix : level.suffix;
            updateData.song = getSongDisplayName({ songObject: song, suffix });
            updateData.songId = song.id;
            updateData.artist = song.artists?.map(artist => artist.name).join(' & ') || '';
          }
        }
      }
    }

    await level.update(updateData, {transaction});

    // Reload level with associations for proper return
    const updatedLevel = await Level.findByPk(levelId, {
      include: [
        {
          model: Difficulty,
          as: 'difficulty',
          required: false,
        },
        {
          model: Song,
          as: 'songObject',
          required: false,
          include: [
            {
              model: Artist,
              as: 'artists',
              required: false,
            },
          ],
        },
      ],
      transaction,
    });

    await transaction.commit();
    const dlLinkChanged =
      req.body.dlLink !== undefined &&
      (oldLevel as { dlLink?: string }).dlLink !== (updatedLevel?.dlLink ?? level.dlLink);
    if (dlLinkChanged) {
      await applyLevelChartStatsFromCdn(levelId);
    } else {
      await elasticsearchService.indexLevel(updatedLevel || level);
    }
    await logLevelMetadataUpdateHook(oldLevel, updatedLevel || level, req.user as User);
    return res.status(200).json({message: 'Level updated successfully', level: updatedLevel || level});
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error updating level:', error);
    return res.status(500).json({error: 'Failed to update level'});
  }
  }
);

router.put(
  '/:id([0-9]{1,20})',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'putLevel',
    summary: 'Update level (admin)',
    description: 'Full level update by super admin (scores, difficulty, metadata, etc.).',
    tags: ['Database', 'Levels'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    requestBody: { description: 'Various level fields', schema: { type: 'object' }, required: true },
    responses: { 200: { description: 'Level updated' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
  // Validate numerical fields before starting transaction
  const numericFields = ['baseScore', 'diffId', 'previousDiffId', 'previousBaseScore', 'ppBaseScore'];
  for (const field of numericFields) {
    if (req.body[field] !== undefined) {
      const parsed = Number(req.body[field]);
      if (isNaN(parsed) || !isFinite(parsed)) {
        return res.status(400).json({
          error: `Invalid value for ${field}: must be a valid number`,
        });
      }
    }
  }

  let transaction: any;

  try {
    transaction = await sequelize.transaction({
      isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ,
    });
    const levelId = parseInt(req.params.id);

    const level = await Level.findOne({
      where: {id: levelId},
      include: [
        {
          model: Difficulty,
          as: 'difficulty',
          required: false,
        },
      ],
      transaction,
      lock: true,
    });

    if (!level) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({error: 'Level not found'});
    }

    // Save old level state for logging before any updates
    const oldLevel = {...level.dataValues} as Level;

    // Check if user is super admin or creator
    const {canEdit, errorMessage} = await checkLevelOwnership(
      levelId,
      req.user,
      transaction,
    );

    if (!canEdit && req.user) {
      await safeTransactionRollback(transaction);
      return res.status(403).json({error: errorMessage});
    }


    if (
      req.body.dlLink &&
      isCdnUrl(level.dlLink) &&
      req.body.dlLink !== level.dlLink
    ) {
      await safeTransactionRollback(transaction);
      return res.status(403).json({
        error:
          'Cannot modify CDN-managed download link directly. Use the upload management endpoints instead.',
      });
    }

    // Initialize previous state variables
    let baseScore = level.baseScore || 0;
    let previousDiffId = level.previousDiffId || 0;
    let previousBaseScore = level.previousBaseScore || 0;

    // Handle rating-related changes
    await handleRatingChanges(level, req, transaction);
    await handleLowDiffFlag(level, req, transaction);

    // Handle flag changes
    const {isDeleted, isHidden, isAnnounced} = handleFlagChanges(level, req);

    if (
      req.body.baseScore !== undefined &&
      !isNaN(Number(req.body.baseScore))
    ) {
      baseScore = Number(req.body.baseScore || 0);
      logger.debug(`Setting baseScore to ${baseScore} for level ${levelId}`);
    }

    if (
      req.body.previousDiffId !== undefined &&
      !isNaN(Number(req.body.previousDiffId))
    ) {
      previousDiffId = Number(req.body.previousDiffId || 0);
      logger.debug(
        `Setting previousDiffId to ${previousDiffId} for level ${levelId}`,
      );
    }

    if (
      req.body.previousBaseScore !== undefined &&
      !isNaN(Number(req.body.previousBaseScore))
    ) {
      previousBaseScore = Number(req.body.previousBaseScore);
      logger.debug(
        `Setting previousBaseScore to ${previousBaseScore} for level ${levelId}`,
      );
    }

    if (req.body.toRate === true && !level.toRate) {
      previousDiffId = level.diffId || 0;
      previousBaseScore = level.baseScore || 0;
      logger.debug(
        `Freezing state for level ${levelId} - previousDiffId: ${previousDiffId}, previousBaseScore: ${previousBaseScore}`,
      );
    }

    // Build update data
    const updateData: any = {
      updatedAt: new Date(),
    };

    // For non-admin creators, only include allowed fields

      // Super admin has access to all fields
    updateData.song = sanitizeTextInput(req.body.song);
    updateData.artist = sanitizeTextInput(req.body.artist);

    // Handle suffix first (before songId processing so it's available for song name formatting)
    if (req.body.suffix !== undefined) {
      updateData.suffix = req.body.suffix && typeof req.body.suffix === 'string'
        ? req.body.suffix.trim() || null
        : null;
    }

    // Handle songId if provided (for normalized song relationships)
    if (req.body.songId !== undefined) {
      if (req.body.songId === null || req.body.songId === '') {
        updateData.songId = null;
      } else {
        const songId = parseInt(req.body.songId);
        if (!isNaN(songId) && songId > 0) {
          const song = await Song.findByPk(songId, {transaction, include: [
            {
              model: Artist,
              as: 'artists',
              required: false,
            },
          ]});
          if (song) {
            // Use suffix from updateData if set, otherwise from current level
            const suffix = updateData.suffix !== undefined ? updateData.suffix : level.suffix;
            updateData.song = getSongDisplayName({ songObject: song, suffix });
            updateData.songId = song.id;
            updateData.artist = song.artists?.map(artist => artist.name).join(' & ') || '';
          }
        }
      }
    }
    // Handle diffId - allow 0 as a valid value
    if (req.body.diffId !== undefined) {
      updateData.diffId = Number(req.body.diffId);
    }
    updateData.previousDiffId = previousDiffId;
    updateData.baseScore = baseScore;
    updateData.ppBaseScore = Number(req.body.ppBaseScore) || 0;
    updateData.previousBaseScore = previousBaseScore;
    updateData.videoLink = sanitizeTextInput(req.body.videoLink);
    updateData.dlLink = sanitizeTextInput(req.body.dlLink);
    updateData.workshopLink = sanitizeTextInput(req.body.workshopLink);
    updateData.publicComments = sanitizeTextInput(req.body.publicComments);
    updateData.rerateNum = sanitizeTextInput(req.body.rerateNum);
    updateData.toRate = req.body.toRate ?? level.toRate;
    updateData.rerateReason = sanitizeTextInput(req.body.rerateReason);
    updateData.isDeleted = isDeleted;
    updateData.isHidden = isHidden;
    updateData.isAnnounced = isAnnounced;
    updateData.isExternallyAvailable = req.body.isExternallyAvailable ?? level.isExternallyAvailable;

    await Level.update(updateData, {
      where: {id: levelId},
      transaction,
    });

    const basescoreTagName = 'Basescore Edit'
    const ppBasescoreTagName = 'Pure Perfect Basescore Increase'
    let basescoreTag = await LevelTag.findOne({where: {name: basescoreTagName}, transaction});
    let ppBasescoreTag = await LevelTag.findOne({where: {name: ppBasescoreTagName}, transaction});
    if (!basescoreTag) { basescoreTag = await LevelTag.create({name: basescoreTagName, color: '#ff0000'}, {transaction}); }
    if (!ppBasescoreTag) { ppBasescoreTag = await LevelTag.create({name: ppBasescoreTagName, color: '#000000'}, {transaction}); }
    if (updateData.baseScore && updateData.baseScore !== level.difficulty?.baseScore) {
      await LevelTagAssignment.upsert({levelId: levelId, tagId: basescoreTag.id}, {transaction});
    } else {
      await LevelTagAssignment.destroy({where: {levelId: levelId, tagId: basescoreTag.id}, transaction}); }
    if (updateData.ppBaseScore) {
      await LevelTagAssignment.upsert({levelId: levelId, tagId: ppBasescoreTag.id}, {transaction});
    } else { await LevelTagAssignment.destroy({where: {levelId: levelId, tagId: ppBasescoreTag.id}, transaction}); }

    // Fetch the updated level again to get the latest state
    const updatedLevel = await Level.findOne({
      where: {id: levelId},
      include: [
        {
          model: Difficulty,
          as: 'difficulty',
          required: false,
        },
        {
          model: LevelTag,
          as: 'tags',
          required: false,
          through: {
            attributes: []
          }
        },
        {
          model: Song,
          as: 'songObject',
          required: false,
          include: [
            {
              model: Artist,
              as: 'artists',
              required: false,
            },
          ],
        },
      ],
      transaction,
    });

    // Insert rerate history if rerate is settled (isAnnounced goes from false to true and diffId/baseScore changes)
    if (
      (level.diffId !== (req.body.diffId ?? level.diffId) ||
        level.baseScore !== (req.body.baseScore ?? level.baseScore)) &&
      level.diffId !== 0 &&
      req.body.diffId !== 0
    ) {
      logger.debug(
        `Inserting rerate history for level ${levelId} - previousDiffId: ${level.diffId}, newDiffId: ${req.body.diffId ?? level.diffId}`,
      );
      await LevelRerateHistory.create(
        {
          levelId: level.id,
          previousDiffId: level.diffId,
          newDiffId: req.body.diffId ?? level.diffId,
          previousBaseScore: level.baseScore || 0,
          newBaseScore: req.body.baseScore ?? (level.baseScore || 0),
          reratedBy: req.user?.id ?? null,
          createdAt: new Date(),
        },
        {transaction},
      );
    }
    const rerateHistory = await LevelRerateHistory.findAll({
      where: {levelId: levelId},
      order: [['createdAt', 'DESC']],
      transaction,
    });
    logger.debug(`Rerate history: ${JSON.stringify(rerateHistory)}`);
    await transaction.commit();

    // Log metadata changes (songId, suffix, etc.)
    if (updatedLevel) {
      await logLevelMetadataUpdateHook(oldLevel, updatedLevel, req.user as User);
    }

    const response = {
      message: 'Level updated successfully',
      level: updatedLevel,
      rerateHistory,
    };
    res.json(response);

    // Handle async operations
    (async () => {
      let recalcTransaction: Transaction | null = null;
      try {
        recalcTransaction = await sequelize.transaction({
          isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED,
        });

        if (updateData.baseScore !== undefined || updateData.diffId !== undefined) {
          const affectedPlayerIds = await handleScoreRecalculations(
            levelId,
            updateData,
            recalcTransaction,
          );
          await elasticsearchService.reindexPlayers(
            Array.from(new Set(affectedPlayerIds)),
          );
        }

        await recalcTransaction.commit();

        sseManager.broadcast({type: 'ratingUpdate'});
        sseManager.broadcast({type: 'levelUpdate'});
        sseManager.broadcast({
          type: 'passUpdate',
          data: {
            levelId,
            action: 'levelUpdate',
          },
        });
      } catch (error) {
        if (recalcTransaction) {
          try {
            await recalcTransaction.rollback();
          } catch (rollbackError) {
            // Ignore rollback errors - transaction might already be rolled back
            logger.warn('Transaction rollback failed:', rollbackError);
          }
        }
        logger.error('Error in async operations after level update:', error);
      }
    })()
      .then(() => {
        return;
      })
      .catch(error => {
        logger.error('Error in async operations after level update:', error);
        return;
      });

    if (updatedLevel) {
      const dlLinkChanged = level.dlLink !== updatedLevel.dlLink;
      if (dlLinkChanged) {
        await applyLevelChartStatsFromCdn(levelId);
      } else {
        await elasticsearchService.indexLevel(updatedLevel.id);
      }
    }

    return;
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error updating level:', error);
    return res.status(500).json({error: 'Failed to update level'});
  }
  }
);

router.delete(
  '/:id([0-9]{1,20})',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'deleteLevel',
    summary: 'Soft delete level',
    description: 'Soft delete a level (super admin).',
    tags: ['Database', 'Levels'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: { 200: { description: 'Level soft deleted' }, ...standardErrorResponses404500 },
  }),
  async (req: Request, res: Response) => {
    let transaction: any;
    try {
      transaction = await sequelize.transaction();
      const levelId = parseInt(req.params.id);

      const level = await Level.findOne({
        where: {id: levelId.toString()},
        include: [
          {
            model: Difficulty,
            as: 'difficulty',
            required: false,
          },
          {
            model: Pass,
            as: 'passes',
            required: false,
            attributes: ['id'],
          },
        ],
        transaction,
      });

      if (!level) {
        return res.status(404).json({error: 'Level not found'});
      }

      await Level.update(
        {isDeleted: true, isHidden: true},
        {
          where: {id: levelId.toString()},
          transaction,
        },
      );

      await transaction.commit();

      res.json({
        level: {
          id: levelId,
          isDeleted: true,
          isHidden: true,
        },
      });

      // Handle cache updates and broadcasts asynchronously
      (async () => {
        try {
          // Get affected players before deletion
          const affectedPasses = await Pass.findAll({
            where: {levelId},
            attributes: ['playerId'],
          });

          const affectedPlayerIds = new Set(
            affectedPasses.map(pass => pass.playerId),
          );

          // Schedule stats update for affected players
          await elasticsearchService.reindexPlayers(Array.from(affectedPlayerIds));


            // Broadcast updates
          sseManager.broadcast({type: 'levelUpdate'});
          sseManager.broadcast({type: 'ratingUpdate'});
        } catch (error) {
          logger.error(
            'Error in async operations after level deletion:',
            error,
          );
        }
      })()
        .then(() => {
          return;
        })
        .catch(error => {
          logger.error(
            'Error in async operations after level deletion:',
            error,
          );
          return;
        });

      return;
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error soft deleting level:', error);
      return res.status(500).json({error: 'Failed to soft delete level'});
    }
  }
);

router.patch(
  '/:id([0-9]{1,20})/restore',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'patchLevelRestore',
    summary: 'Restore level',
    description: 'Restore a soft-deleted level (super admin).',
    tags: ['Database', 'Levels'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: { 200: { description: 'Level restored' }, ...standardErrorResponses404500 },
  }),
  async (req: Request, res: Response) => {
    let transaction: any;

    try {
      transaction = await sequelize.transaction();
      const {id} = req.params;

      const level = await Level.findOne({
        where: {id: parseInt(id)},
        transaction,
      });

      if (!level) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({error: 'Level not found'});
      }

      // Restore both isDeleted and isHidden flags
      await Level.update(
        {
          isDeleted: false,
          isHidden: false,
        },
        {
          where: {id: parseInt(id)},
          transaction,
        },
      );

      // Reload the level to get updated data
      await level.reload({
        include: [
          {
            model: Difficulty,
            as: 'difficulty',
          },
          {
            model: Pass,
            as: 'passes',
            required: false,
            attributes: ['id'],
          },
          {
            model: LevelTag,
            as: 'tags',
            required: false,
            through: {
              attributes: []
            }
          }
        ],
        transaction,
      });

      await transaction.commit();

      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      (async () => {
        try {
          sseManager.broadcast({type: 'levelUpdate'});
          sseManager.broadcast({type: 'ratingUpdate'});
          // Reindex only players who have passes on this restored level
          const affectedPasses = await Pass.findAll({
            where: {levelId: parseInt(id)},
            attributes: ['playerId'],
          });
          const affectedPlayerIds = Array.from(
            new Set(affectedPasses.map(p => p.playerId).filter((x): x is number => !!x)),
          );
          if (affectedPlayerIds.length > 0) {
            await elasticsearchService.reindexPlayers(affectedPlayerIds);
          }
        } catch (error) {
          logger.error('Error in async operations after level restore:', error);
        }
      })();

      return res.json({
        level: {
          id: level.id,
          isDeleted: false,
          isHidden: false,
        },
      });
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error restoring level:', error);
      return res.status(500).json({error: 'Failed to restore level'});
    }
  }
);

// Toggle hidden status
router.patch(
  '/:id([0-9]{1,20})/toggle-hidden',
  Auth.verified(),
  ApiDoc({
    operationId: 'patchLevelToggleHidden',
    summary: 'Toggle level hidden',
    description: 'Toggle hidden status (creator or super admin).',
    tags: ['Database', 'Levels'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: { 200: { description: 'Hidden toggled' }, ...standardErrorResponses403404500 },
  }),
  async (req: Request, res: Response) => {
    let transaction: any;

    try {
      transaction = await sequelize.transaction();
      const {id} = req.params;
      const levelId = parseInt(id);

      const level = await Level.findOne({
        where: {id: levelId},
        transaction,
      });

      if (!level) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({error: 'Level not found'});
      }

      // Check if user is super admin or creator
      const {canEdit, errorMessage} = await checkLevelOwnership(
        levelId,
        req.user,
        transaction,
      );

      // Allow super admin or creator (no charter count restriction for hiding)
      if (!canEdit) {
        await safeTransactionRollback(transaction);
        return res.status(403).json({error: errorMessage});
      }

      // Toggle the hidden status
      await Level.update(
        {isHidden: !level.isHidden},
        {
          where: {id: levelId},
          transaction,
        },
      );

      await transaction.commit();

      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      (async () => {
        try {
          sseManager.broadcast({type: 'levelUpdate'});
        } catch (error) {
          logger.error('Error in async operations after toggle hidden:', error);
        }
      })();

      return res.json({
        level: {
          id: level.id,
          isHidden: !level.isHidden,
        },
      });
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error toggling level hidden status:', error);
      return res.status(500).json({
        error: 'Failed to toggle level hidden status',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

router.put(
  '/:id([0-9]{1,20})/like',
  Auth.verified(),
  ApiDoc({
    operationId: 'putLevelLike',
    summary: 'Like/unlike level',
    description: 'Like or unlike a level (action: "like" | "unlike").',
    tags: ['Database', 'Levels'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    requestBody: { description: 'action: "like" | "unlike"', schema: { type: 'object', properties: { action: { type: 'string', enum: ['like', 'unlike'] } }, required: ['action'] }, required: true },
    responses: { 200: { description: 'Like updated' }, 400: { schema: errorResponseSchema }, 401: { schema: errorResponseSchema }, ...standardErrorResponses404500 },
  }),
  async (req: Request, res: Response) => {
    let transaction: any;
    if (!req.user) {
      return res.status(401).json({error: 'Unauthorized'});
    }
    try {
      transaction = await sequelize.transaction();
      const levelId = parseInt(req.params.id);
      const {action} = req.body;

      if (!action || !['like', 'unlike'].includes(action)) {
        await safeTransactionRollback(transaction);
        return res
          .status(400)
          .json({error: 'Invalid action. Must be "like" or "unlike"'});
      }

      // Check if level exists
      const level = await Level.findByPk(levelId, {transaction});
      if (!level) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({error: 'Level not found'});
      }

      // Check if level is deleted
      if (level.isDeleted) {
        await safeTransactionRollback(transaction);
        return res.status(403).json({error: 'Cannot like deleted level'});
      }
      if (action === 'like') {
        // Use findOrCreate to handle race conditions atomically
        const [created] = await LevelLikes.findOrCreate({
          where: {levelId, userId: req.user?.id},
          transaction,
        });

        if (!created) {
          await safeTransactionRollback(transaction);
          return res
            .status(400)
            .json({error: 'You have already liked this level'});
        }
      } else {
        // Check if user already liked the level
        const existingLike = await LevelLikes.findOne({
          where: {levelId, userId: req.user?.id},
          transaction,
        });

        if (!existingLike) {
          await safeTransactionRollback(transaction);
          return res.status(400).json({error: 'You have not liked this level'});
        }

        // Remove like
        await LevelLikes.destroy({
          where: {levelId, userId: req.user?.id},
          transaction,
        });
      }

      await transaction.commit();

      // Invalidate cache for this level's like status
      await CacheInvalidation.invalidateTag(`level:${levelId}:isLiked`).catch(err =>
        logger.error('Error invalidating like cache:', err)
      );

      // Get updated like count
      const likeCount = await LevelLikes.count({
        where: {levelId},
      });

      return res.json({
        success: true,
        action,
        likes: likeCount,
      });
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error toggling level like:', error);
      return res.status(500).json({error: 'Failed to toggle level like'});
    }
  }
);

// Upload management endpoints
router.post(
  '/:id([0-9]{1,20})/upload',
  Auth.verified(),
  ApiDoc({
    operationId: 'postLevelUpload',
    summary: 'Upload level file',
    description: 'Upload or replace level file (chunked upload fileId). Creator or super admin.',
    tags: ['Database', 'Levels'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    requestBody: { description: 'sessionId (new chunked upload) OR fileId (legacy chunked upload); fileName, fileSize; optional uploadJobId (UUID) for GET /v2/jobs/:jobId progress', schema: { type: 'object', properties: { sessionId: { type: 'string' }, fileId: { type: 'string' }, fileName: { type: 'string' }, fileSize: { type: 'integer' }, uploadJobId: { type: 'string', format: 'uuid' } } }, required: true },
    responses: {
      200: { description: 'Upload success' },
      202: { description: 'Accepted — processing continues; poll GET /v2/jobs/:uploadJobId or SSE stream' },
      400: { schema: errorResponseSchema },
      403: { schema: errorResponseSchema },
      404: { schema: errorResponseSchema },
      409: { schema: errorResponseSchema },
      499: { schema: errorResponseSchema },
      ...standardErrorResponses500,
    },
  }),
  async (req: Request, res: Response) => {
    let uploadSession: UploadSession | null = null;
    let assembledFilePath = '';
    let encodedZipFileName = '';
    let legacyFileId: string | null = null;

    try {
      const {sessionId, fileId, fileName, fileSize, uploadJobId: rawUploadJobId} = req.body;
      const uploadJobId = isUuidJobId(rawUploadJobId) ? rawUploadJobId.trim() : undefined;
      const levelId = parseInt(req.params.id);

      const { expectedDlLink, canEdit } = await sequelize.transaction(async (t) => {
        if (sessionId && typeof sessionId === 'string') {
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
        } else {
          if (!fileId || !fileName || !fileSize) {
            throw { error: 'Missing required file information', code: 400 };
          }
          legacyFileId = fileId;
          assembledFilePath = path.join('uploads', 'assembled', req.user!.id, `${fileId}.zip`);
          encodedZipFileName = fileName;
        }

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

      if (activeLevelZipFinalizeByLevelId.has(levelId)) {
        throw {
          error: 'Another zip upload is already processing for this level. Wait for it to finish.',
          code: 409,
        };
      }

      const runFinalizeOnce = async (response: Response | null) => {
        if (!uploadSession) {
          let fileExists = false;
          let retries = 5;
          while (!fileExists && retries > 0) {
            try {
              await fs.promises.access(assembledFilePath);
              fileExists = true;
            } catch {
              retries -= 1;
              if (retries === 0) {
                throw new Error(
                  'Assembled file not found. The upload may be incomplete or expired.',
                );
              }
              await new Promise((resolve) => setTimeout(resolve, 500));
            }
          }
        }

        const fileBuffer = await fs.promises.readFile(assembledFilePath);

        await finalizeLevelZipUploadFromBuffer({
          req,
          res: response,
          levelId,
          expectedDlLink,
          fileBuffer,
          encodedZipFileName,
          assembledFilePathToUnlink: uploadSession ? null : assembledFilePath,
          chunkUploadFileIdForCleanupExclude: legacyFileId,
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
        void (async () => {
          try {
            await runFinalizeOnce(null);
          } catch (err) {
            logger.error('Async level zip finalise failed', {
              levelId,
              error: err instanceof Error ? err.message : String(err),
            });
          } finally {
            activeLevelZipFinalizeByLevelId.delete(levelId);
          }
        })();

        return res.status(202).json({
          accepted: true,
          uploadJobId,
          levelId,
          message: 'Processing started',
        });
      }

      activeLevelZipFinalizeByLevelId.set(levelId, 'sync');
      try {
        try {
          await runFinalizeOnce(res);
        } catch (error) {
          if (uploadSession) {
            try {
              await cancelUploadSession(uploadSession);
            } catch (cleanupError) {
              logger.warn('Failed to cancel upload session after error:', cleanupError);
            }
          } else if (legacyFileId) {
            try {
              await fs.promises.unlink(assembledFilePath);
            } catch (cleanupError: any) {
              if (cleanupError.code !== 'ENOENT') {
                logger.warn('Failed to clean up assembled file:', cleanupError);
              }
            }
          }
          throw error;
        }
      } finally {
        activeLevelZipFinalizeByLevelId.delete(levelId);
      }
      return;
    } catch (error: any) {

      // Handle client disconnection gracefully - this is expected behavior
      if (error instanceof Error && error.message.includes('Client disconnected')) {
        logger.warn('Client disconnected during level file upload:', {
          levelId: req.params.id,
          fileId: req.body.fileId,
          userId: req.user?.id,
        });
        // Don't send response if headers already sent
        if (!res.headersSent && !res.writableEnded) {
          try {
            return res.status(499).json({
              error: 'Client disconnected during upload',
            });
          } catch (writeError: any) {
            // Ignore write errors if client truly disconnected
            if (writeError.code !== 'ECONNRESET' && writeError.code !== 'EPIPE') {
              logger.warn('Error sending disconnect response:', writeError);
            }
          }
        }
        return;
      }

      const statusCode =
        typeof error.code === 'number' && error.code >= 100 && error.code < 600
          ? error.code
          : 500;
      if (statusCode === 500) logger.error('Error uploading level file:', error);
      return res.status(statusCode).json(error);
    }
  }
);

router.post(
  '/:id([0-9]{1,20})/upload-from-url',
  Auth.verified(),
  ApiDoc({
    operationId: 'postLevelUploadFromUrl',
    summary: 'Upload level zip from URL',
    description:
      'Super admin only. Downloads a remote .zip over http(s), validates it, uploads to CDN, and updates the level like POST /upload.',
    tags: ['Database', 'Levels'],
    security: ['bearerAuth'],
    params: {id: idParamSpec},
    requestBody: {
      description: 'Direct download URL for a zip file',
      schema: {
        type: 'object',
        properties: {
          url: {type: 'string'},
          uploadJobId: {type: 'string', format: 'uuid'},
        },
        required: ['url'],
      },
      required: true,
    },
    responses: {
      200: { description: 'Upload success' },
      202: { description: 'Accepted — CDN processing continues; poll job progress' },
      400: { schema: errorResponseSchema },
      403: { schema: errorResponseSchema },
      404: { schema: errorResponseSchema },
      409: { schema: errorResponseSchema },
      ...standardErrorResponses500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      if (!req.user || !hasFlag(req.user, permissionFlags.SUPER_ADMIN)) {
        throw {error: 'Forbidden', code: 403};
      }

      const {url, uploadJobId: rawUploadJobId} = req.body;
      const uploadJobId = isUuidJobId(rawUploadJobId) ? rawUploadJobId.trim() : undefined;
      const levelId = parseInt(req.params.id);
      if (!url || typeof url !== 'string') {
        throw {error: 'Missing url', code: 400};
      }
      const trimmed = url.trim();
      if (!trimmed) {
        throw {error: 'Missing url', code: 400};
      }
      if (!isValidHttpUrl(trimmed)) {
        throw {error: 'Invalid download URL', code: 400};
      }
      if (isCdnUrl(trimmed)) {
        throw {error: 'URL must not point to the site CDN', code: 400};
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
            meta: {levelId, source: 'upload_from_url', stage: 'download'},
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
            if (
              now - lastDownloadProgressAt < 350 &&
              Math.abs(percent - lastDownloadPercent) < 2
            ) {
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
          onProgress: ({loaded, total, percent}) => emitDownloadProgress(loaded, total, percent),
        });
      } catch (downloadErr: unknown) {
        const fail = asZipUrlDownloadFailure(downloadErr);
        if (fail.code >= 400 && fail.code < 600) {
          logger.debug('upload-from-url: download failed', {code: fail.code, error: fail.error});
          throw fail;
        }
        logger.debug('upload-from-url: download unexpected', {code: fail.code, error: fail.error});
        throw {error: fail.error, code: 400};
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

        return res.status(202).json({
          accepted: true,
          uploadJobId,
          levelId,
          message: 'Processing started',
        });
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
      return;
    } catch (error: any) {
      const uploadJobIdErr = isUuidJobId(req.body?.uploadJobId) ? String(req.body.uploadJobId).trim() : undefined;
      if (uploadJobIdErr && req.user?.id && !res.headersSent) {
        const msg =
          typeof error?.error === 'string'
            ? error.error
            : error instanceof Error
              ? error.message
              : String(error);
        await jobProgressService.patchTrusted(uploadJobIdErr, {
          phase: 'failed',
          error: msg,
          percent: null
        }).catch(() => undefined);
      }
      const statusCode =
        typeof error.code === 'number' && error.code >= 100 && error.code < 600
          ? error.code
          : 500;
      if (statusCode === 500) logger.error('Error uploading level file from URL:', error);
      return res.status(statusCode).json(error);
    }
  },
);

router.post(
  '/:id([0-9]{1,20})/select-level',
  Auth.verified(),
  ApiDoc({
    operationId: 'postLevelSelectLevel',
    summary: 'Select level file',
    description: 'Set target level index for a CDN level file. Creator or super admin.',
    tags: ['Database', 'Levels'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    requestBody: { description: 'selectedLevel: full path or relative path string', schema: { type: 'object', properties: { selectedLevel: { type: 'string' } }, required: ['selectedLevel'] }, required: true },
    responses: { 200: { description: 'Level selected' }, 400: { schema: errorResponseSchema }, ...standardErrorResponses403404500 },
  }),
  async (req: Request, res: Response) => {
    let transaction: any;

    try {
      transaction = await sequelize.transaction();
      const {selectedLevel} = req.body;
      const levelId = parseInt(req.params.id);
      if (!selectedLevel) {
        throw {error: 'Missing selected level', code: 400};
      }

      const level = await Level.findByPk(levelId, {transaction});
      if (!level) {
        throw {error: 'Level not found', code: 404};
      }

      // Check ownership
      const {canEdit, errorMessage} = await checkLevelOwnership(levelId, req.user, transaction);

      // Allow super admin or creators with ≤2 CHARTERS
      if (!canEdit) {
        throw {error: errorMessage, code: 403};
      }

      const fileId = level.fileId ?? null;
      if (!fileId) {
        throw {error: 'File ID is required', code: 400};
      }

      const file = await cdnService.setTargetLevel(fileId, selectedLevel);
      if (!file) {
        throw {error: 'File not found', code: 404};
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

      // Log webhook for non-admin creators
      try {
        await logLevelTargetUpdateHook(selectedLevel.toString(), levelId, getUserModel(req.user));
      } catch (webhookError) {
        logger.warn('Failed to send webhook for level target update:', webhookError);
      }


      return res.json({
        success: true,
        message: 'Level file selected successfully',
      });
    } catch (error: any) {
      await safeTransactionRollback(transaction);
      const statusCode =
        typeof error.code === 'number' && error.code >= 100 && error.code < 600
          ? error.code
          : 500;
      if (statusCode === 500) logger.error('Error selecting level file:', error);
      return res.status(statusCode).json(error);
    }
  }
);

router.delete(
  '/:id([0-9]{1,20})/upload',
  Auth.verified(),
  ApiDoc({
    operationId: 'deleteLevelUpload',
    summary: 'Delete level file',
    description: 'Remove CDN level file and clear dlLink. Creator or super admin.',
    tags: ['Database', 'Levels'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: { 200: { description: 'File removed' }, 400: { schema: errorResponseSchema }, ...standardErrorResponses403404500 },
  }),
  async (req: Request, res: Response) => {
    let transaction: any;

    try {
      transaction = await sequelize.transaction();
      const levelId = parseInt(req.params.id);

      // Get current level
      const level = await Level.findByPk(levelId, {transaction});
      if (!level) {
        throw {error: 'Level not found', code: 404};
      }

      // Check ownership
      const {canEdit, errorMessage} = await checkLevelOwnership(levelId, req.user, transaction);

      // Allow super admin or creators with ≤2 CHARTERS
      if (!canEdit) {
        throw {error: errorMessage, code: 403};
      }

      if (level.clears > 0 && !hasFlag(req.user, permissionFlags.SUPER_ADMIN)) {
        throw {error: 'You cannot delete a level with clears, request it in the discord server.', code: 400};
      }

      // Check if level has a CDN-managed file
      if (!level.dlLink || !isCdnUrl(level.dlLink)) {
        throw {error: 'Level does not have a CDN-managed file', code: 400};
      }

      // Delete file from CDN
      const fileId = level.fileId!;
      if (!fileId) {
        throw {error: 'Level does not have a CDN-managed file', code: 400};
      }
      logger.debug(`Deleting file from CDN: ${fileId}`);
      await cdnService.deleteFile(fileId);

      // Update level to remove download link
      await Level.update(
        {
          dlLink: 'removed',
          bpm: null,
          tilecount: null,
          levelLengthInMs: null,
        },
        {
          where: {id: levelId},
          transaction,
        },
      );

      await transaction.commit();

      // Log webhook
      try {
        await logLevelFileDeleteHook(levelId, getUserModel(req.user));
      } catch (webhookError) {
        // Log webhook error but don't fail the request
        logger.warn('Failed to send webhook for level file delete:', webhookError);
      }

      return res.json({
        success: true,
        dlLink: 'removed',
        message: 'Level file deleted successfully',
      });
    } catch (error: any) {
      await safeTransactionRollback(transaction);
      const statusCode =
        typeof error.code === 'number' && error.code >= 100 && error.code < 600
          ? error.code
          : 500;
      if (statusCode === 500) logger.error('Error deleting level file:', error);
      return res.status(statusCode).json(error);
    }
  }
);

// Refresh auto-assigned tags for a level
router.post(
  '/:id([0-9]{1,20})/refresh-tags',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'postLevelRefreshTags',
    summary: 'Refresh level tags',
    description: 'Re-run auto tag assignment for a level (super admin).',
    tags: ['Database', 'Levels'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: { 200: { description: 'Tags refreshed' }, ...standardErrorResponses404500 },
  }),
  async (req: Request, res: Response) => {
  try {
    const levelId = parseInt(req.params.id);

    const level = await Level.findByPk(levelId);
    if (!level) {
      return res.status(404).json({error: 'Level not found'});
    }

    // Refresh auto-assigned tags
    const result = await tagAssignmentService.refreshAutoTags(levelId);

    // Reindex level in Elasticsearch if tags changed
    if (result.assignedTags.length > 0 || result.removedTags.length > 0) {
      await elasticsearchService.reindexLevels([levelId]);
    }

    return res.json({
      success: true,
      message: 'Auto-assigned tags refreshed successfully',
      removedTags: result.removedTags,
      assignedTags: result.assignedTags,
      errors: result.errors,
    });
  } catch (error) {
    logger.error('Error refreshing auto tags:', error);
    return res.status(500).json({
      error: 'Failed to refresh auto tags',
      details: error instanceof Error ? error.message : String(error),
    });
  }
  }
);

export default router;
