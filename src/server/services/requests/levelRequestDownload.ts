import {getSequelizeForModelGroup} from '@/config/db.js';
import {CDN_CONFIG} from '@/externalServices/cdnService/config.js';
import {matchLevelFileBySelection} from '@/externalServices/cdnService/domain/level/matchLevelFileSelection.js';
import Level from '@/models/levels/Level.js';
import LevelRequest from '@/models/levels/LevelRequest.js';
import User from '@/models/auth/User.js';
import {INFO_CHANGE_VALUE_MAX} from '@/misc/utils/data/levelRequestValidation.js';
import {applyLevelChartStatsFromCdn} from '@/misc/utils/data/levelChartStatsSync.js';
import {isCdnUrl} from '@/misc/utils/Utility.js';
import {logger} from '@/server/services/core/LoggerService.js';
import cdnService, {CdnError} from '@/server/services/core/CdnService.js';
import {cleanUpCdnFile} from '@/server/routes/v2/misc/form/shared/cdnCleanup.js';
import {tagAssignmentService} from '@/server/services/data/TagAssignmentService.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import {logLevelFileUpdateHook, logLevelFileUploadHook} from '@/server/routes/v2/webhooks/misc.js';
import {
  chartStatsFromLevel,
  classifyPreviousSource,
  extractZipFilesSnapshot,
  oldChartStatsForPreviousSource,
} from '@/server/domain/levels/levelFileDiscordSnapshot.js';
import {
  LevelZipSessionError,
  cancelIngestedLevelZipSession,
  discardIngestedLevelZip,
  ingestOwnedLevelZip,
  type IngestedLevelZip,
  type IngestedLevelZipChart,
} from '@/server/domain/levels/levelZipSessionIngest.js';

const sequelize = getSequelizeForModelGroup('levels');
const elasticsearchService = ElasticsearchService.getInstance();

export class DownloadAttachError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'DownloadAttachError';
    this.status = status;
    this.code = code;
  }
}

export type DownloadSelection = {
  requiresLevelSelection?: boolean;
  fileId?: string;
  levelFiles?: IngestedLevelZipChart[];
};

type StagedDownload = {
  fileId: string;
  value: string;
  originalName: string;
  zipSizeBytes: number;
  requiresLevelSelection: boolean;
  targetLevel: string | null;
};

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function stagedDownloadFileId(payload: Record<string, unknown> | null | undefined): string | null {
  if (!payload || payload.kind !== 'download') return null;
  const fileId = trimmed(payload.fileId);
  return fileId || null;
}

export function readStagedDownload(payload: Record<string, unknown> | null | undefined): StagedDownload | null {
  const fileId = stagedDownloadFileId(payload);
  if (!fileId || !payload) return null;
  const value = trimmed(payload.value);
  if (!value) {
    throw new DownloadAttachError(400, 'upload', 'The attached download is missing its file link');
  }
  const targetLevel = trimmed(payload.targetLevel) || null;
  return {
    fileId,
    value,
    originalName: trimmed(payload.originalName) || 'level.zip',
    zipSizeBytes: typeof payload.zipSizeBytes === 'number' && Number.isFinite(payload.zipSizeBytes)
      ? payload.zipSizeBytes
      : 0,
    requiresLevelSelection: payload.requiresLevelSelection === true && !targetLevel,
    targetLevel,
  };
}

export function downloadSelection(ingested: IngestedLevelZip | null): DownloadSelection {
  if (!ingested || ingested.levelFiles.length <= 1) return {};
  return {
    requiresLevelSelection: true,
    fileId: ingested.fileId,
    levelFiles: ingested.levelFiles,
  };
}

export async function deleteStagedDownload(payload: Record<string, unknown> | null | undefined): Promise<void> {
  await cleanUpCdnFile(stagedDownloadFileId(payload));
}

function payloadFromExisting(existing: Record<string, unknown>): Record<string, unknown> {
  const staged = readStagedDownload(existing);
  if (!staged) {
    throw new DownloadAttachError(400, 'value', 'Enter the new value');
  }
  return {
    kind: 'download',
    value: staged.value,
    fileId: staged.fileId,
    originalName: staged.originalName,
    zipSizeBytes: staged.zipSizeBytes,
    requiresLevelSelection: staged.requiresLevelSelection,
    targetLevel: staged.targetLevel,
    ...(Array.isArray(existing.levelFiles) ? {levelFiles: existing.levelFiles} : {}),
  };
}

function linkPayload(value: string, level: Level): Record<string, unknown> {
  if (!value) throw new DownloadAttachError(400, 'value', 'Enter the new value');
  if (value.length > INFO_CHANGE_VALUE_MAX) {
    throw new DownloadAttachError(400, 'value_length', 'That value must be at most 4000 characters');
  }
  if (CDN_CONFIG.baseUrl && value.startsWith(CDN_CONFIG.baseUrl)) {
    throw new DownloadAttachError(400, 'cdn_link', 'Direct download cannot point to local CDN');
  }
  if (level.dlLink != null && value === String(level.dlLink).trim()) {
    throw new DownloadAttachError(400, 'unchanged', 'This already matches the level');
  }
  return {kind: 'download', value};
}

/**
 * A download change is either a pasted external link or a level-zip session, never both.
 * `keepDownloadFile` preserves a zip already stored on a pending request.
 */
export async function prepareDownloadChange(
  userId: string,
  body: Record<string, unknown>,
  level: Level,
  existing: Record<string, unknown> | null,
): Promise<{payload: Record<string, unknown>; ingested: IngestedLevelZip | null}> {
  const uploadSessionId = trimmed(body.uploadSessionId);
  const uploadJobId = trimmed(body.uploadJobId) || null;
  const value = trimmed(body.value);
  const keep = body.keepDownloadFile === true;
  if ((uploadSessionId && value) || (uploadSessionId && keep) || (value && keep)) {
    throw new DownloadAttachError(400, 'download_both', 'Attach a zip or paste a link, not both');
  }
  if (uploadSessionId) {
    const ingested = await ingestOwnedLevelZip({
      uploadSessionId,
      userId,
      uploadJobId,
      purpose: 'levelRequest',
      jobKind: 'level_request_upload',
      jobSource: 'level_request',
    });
    return {
      ingested,
      payload: {
        kind: 'download',
        value: ingested.directDl,
        fileId: ingested.fileId,
        originalName: ingested.originalName,
        zipSizeBytes: ingested.zipSizeBytes,
        requiresLevelSelection: ingested.levelFiles.length > 1,
        targetLevel: null,
        ...(ingested.levelFiles.length > 1 ? {levelFiles: ingested.levelFiles} : {}),
      },
    };
  }
  if (keep) {
    return {ingested: null, payload: payloadFromExisting(existing || {})};
  }
  return {ingested: null, payload: linkPayload(value, level)};
}

export async function selectDownloadRequestChart(
  request: LevelRequest,
  selectedLevel: unknown,
): Promise<void> {
  const staged = readStagedDownload(request.payload);
  if (!staged) {
    throw new DownloadAttachError(400, 'upload', 'This request has no uploaded file');
  }
  if (typeof selectedLevel !== 'string' || !selectedLevel.trim()) {
    throw new DownloadAttachError(400, 'chart', 'Choose a chart from this zip');
  }
  const levelFiles = await cdnService.getLevelFiles(staged.fileId);
  const selectedFile = matchLevelFileBySelection(
    levelFiles.map((file) => ({
      ...file,
      path: file.storagePath || file.fullPath,
      relativePath: file.relativePath || file.fullPath,
    })),
    selectedLevel,
  );
  if (!selectedFile) {
    throw new DownloadAttachError(400, 'chart', 'Selected level file not found');
  }
  const resolvedSelection = selectedFile.relativePath || selectedFile.fullPath || selectedFile.storagePath || selectedLevel.trim();
  await cdnService.setTargetLevel(staged.fileId, resolvedSelection);
  await request.update({
    payload: {
      ...request.payload,
      targetLevel: resolvedSelection,
      requiresLevelSelection: false,
    },
  });
}

export async function acceptStagedDownload(
  userId: string,
  request: LevelRequest,
  notePatch: Record<string, unknown>,
): Promise<void> {
  const staged = readStagedDownload(request.payload);
  if (!staged) return;
  if (staged.requiresLevelSelection) {
    throw new DownloadAttachError(409, 'chart_required', 'Choose a chart from this zip before accepting');
  }
  try {
    await cdnService.getLevelFiles(staged.fileId);
  } catch (err) {
    if (err instanceof CdnError && err.httpStatus === 404) {
      throw new DownloadAttachError(409, 'file_missing', 'The uploaded file is no longer available');
    }
    throw err;
  }

  const swap: {
    previousUrl: string | null;
    previousFileId: string | null;
    oldStats: {
      bpm?: number | null;
      tilecount?: number | null;
      midspinCount?: number | null;
      autoTileCount?: number | null;
      levelLengthInMs?: number | null;
    } | null;
  } = {previousUrl: null, previousFileId: null, oldStats: null};

  await sequelize.transaction(async (t) => {
    const lockedRequest = await LevelRequest.findByPk(request.id, {transaction: t, lock: t.LOCK.UPDATE});
    if (!lockedRequest || lockedRequest.status !== 'pending') {
      throw new DownloadAttachError(409, 'action', 'That action is not available for this request');
    }
    const fresh = await Level.findByPk(request.levelId, {transaction: t, lock: t.LOCK.UPDATE});
    if (!fresh) throw new DownloadAttachError(404, 'missing_level', 'Level not found');
    swap.previousUrl = typeof fresh.dlLink === 'string' ? fresh.dlLink : null;
    swap.previousFileId = fresh.fileId ?? null;
    swap.oldStats = {
      bpm: fresh.bpm,
      tilecount: fresh.tilecount,
      midspinCount: fresh.midspinCount,
      autoTileCount: fresh.autoTileCount,
      levelLengthInMs: fresh.levelLengthInMs,
    };
    if ((fresh.dlLink || '') !== staged.value) {
      fresh.dlLink = staged.value;
      await fresh.save({transaction: t});
    }
    await lockedRequest.update({
      ...notePatch,
      status: 'completed',
      resolvedAt: new Date(),
      lastActorUserId: userId,
    }, {transaction: t});
  });

  await request.reload();

  try {
    await applyLevelChartStatsFromCdn(request.levelId);
  } catch (chartSyncError) {
    logger.warn('Failed to sync chart stats after download request accept', {
      levelId: request.levelId,
      error: chartSyncError instanceof Error ? chartSyncError.message : String(chartSyncError),
    });
  }

  try {
    const actor = await User.findByPk(userId);
    if (actor) {
      const levelFiles = await cdnService.getLevelFiles(staged.fileId);
      let files = extractZipFilesSnapshot(null, levelFiles);
      try {
        const metadata = await cdnService.getFileMetadata(staged.fileId);
        files = extractZipFilesSnapshot(metadata, levelFiles);
      } catch (metadataError) {
        logger.warn('Failed to load CDN metadata for download request file hook', {
          levelId: request.levelId,
          fileId: staged.fileId,
          error: metadataError instanceof Error ? metadataError.message : String(metadataError),
        });
      }
      const afterStats = await Level.findByPk(request.levelId, {
        attributes: ['bpm', 'tilecount', 'midspinCount', 'autoTileCount', 'levelLengthInMs'],
      });
      const snapshot = {
        newFileId: staged.fileId,
        zipFilename: staged.originalName,
        zipSizeBytes: staged.zipSizeBytes,
        uploadSource: 'level_request',
        files,
        newChartStats: chartStatsFromLevel(afterStats),
      };
      if (swap.previousUrl && swap.previousUrl.length > 12) {
        const previousSource = classifyPreviousSource(swap.previousUrl, isCdnUrl(swap.previousUrl));
        await logLevelFileUpdateHook({
          originalPath: swap.previousUrl,
          newPath: staged.value,
          levelId: request.levelId,
          previousSource,
          oldChartStats: oldChartStatsForPreviousSource(previousSource, swap.oldStats),
          ...snapshot,
        }, actor);
      } else {
        await logLevelFileUploadHook({
          filePath: staged.value,
          levelId: request.levelId,
          ...snapshot,
        }, actor);
      }
    }
  } catch (webhookError) {
    logger.warn('Failed to send webhook for download request accept', webhookError);
  }

  if (swap.previousFileId && swap.previousFileId !== staged.fileId && swap.previousUrl) {
    try {
      await cdnService.deleteFileForStoredUrl(swap.previousUrl, swap.previousFileId);
    } catch (cleanupError) {
      logger.error('Failed to delete previous CDN file after download request accept', {
        levelId: request.levelId,
        previousFileId: swap.previousFileId,
        newFileId: staged.fileId,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
  }

  try {
    const tagResult = await tagAssignmentService.refreshAutoTags(request.levelId);
    if (tagResult.assignedTags.length > 0 || tagResult.removedTags.length > 0) {
      await elasticsearchService.reindexLevels([request.levelId]);
    }
  } catch (tagError) {
    logger.warn('Failed to refresh auto tags after download request accept', {
      levelId: request.levelId,
      error: tagError instanceof Error ? tagError.message : String(tagError),
    });
  }
}

export type {IngestedLevelZip, IngestedLevelZipChart};
export {LevelZipSessionError, cancelIngestedLevelZipSession, discardIngestedLevelZip};
