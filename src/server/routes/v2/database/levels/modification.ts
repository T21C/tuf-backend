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
import {
  buildLevelScoreContext,
  computePassScoreV2,
} from '@/misc/utils/pass/scoreService.js';
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
import {updateWorldsFirstPPStatus} from '@/server/routes/v2/database/passes/index.js';
import { applyLevelChartStatsFromCdn } from '@/misc/utils/data/levelChartStatsSync.js';
import {
  isCdnUrl,
  safeTransactionRollback,
  sanitizeTextInput,
} from '@/misc/utils/Utility.js';
import cdnService from '@/server/services/core/CdnService.js';
import LevelRerateHistory from '@/models/levels/LevelRerateHistory.js';
import LevelTag from '@/models/levels/LevelTag.js';
import {permissionFlags} from '@/config/constants.js';
import {hasFlag} from '@/misc/utils/auth/permissionUtils.js';
import {tagAssignmentService} from '@/server/services/data/TagAssignmentService.js';
import { logLevelMetadataUpdateHook } from '@/server/routes/v2/webhooks/misc.js';
import LevelTagAssignment from '@/models/levels/LevelTagAssignment.js';
import { getSongDisplayName, getArtistDisplayName } from '@/misc/utils/data/levelHelpers.js';
import Song from '@/models/songs/Song.js';
import Artist from '@/models/artists/Artist.js';
import {executePermanentLevelDeleteWithSideEffects} from '@/server/domain/levels/levelPermanentDelete.js';
import {
  syncAnnouncementQueueAfterLevelSave,
  syncAnnouncementQueueAfterCurveChange,
} from '@/server/services/announcements/levelAnnouncementQueue.js';
import {
  validateXaccCurveParams,
  XACC_CURVE_DEFAULTS,
} from '@/misc/utils/pass/scoreV2XaccCurve.js';
const playerStatsService = PlayerStatsService.getInstance();
const elasticsearchService = ElasticsearchService.getInstance();

/** Chunk size for pass score bulk updates (large levels). */
const PASS_SCORE_RECALC_BATCH = 500;

type PassScoreRecalcResult = {
  playerIds: number[];
  passIds: number[];
  updatedCount: number;
};

import {
  checkLevelOwnership,
  type OwnershipCheckResult,
} from '@/server/domain/levels/levelOwnership.js';
import {
  executeLevelPayloadSwap,
  LevelPayloadSwapError,
} from '@/server/domain/levels/levelPayloadSwap.js';
import { getPassIdsByLevelId } from '@/server/services/elasticsearch/projectors/cdcFanout.js';
import { invalidatePackLevelsCachesForLevelIds } from '@/server/services/packs/packDetailCacheService.js';

export { checkLevelOwnership, type OwnershipCheckResult };

async function rebuildLegacySongWhenSuffixChanges(
  level: Level,
  suffix: string | null | undefined,
  transaction: Transaction,
): Promise<string | undefined> {
  if (level.songId == null) return undefined;
  const song = await Song.findByPk(level.songId, {
    transaction,
    include: [{ model: Artist, as: 'artists', required: false }],
  });
  if (!song) return undefined;
  return getSongDisplayName({ songObject: song, suffix: suffix ?? null });
}

const CHART_STATS_FIELDS = ['bpm', 'tilecount', 'levelLengthInMs', 'autoTileCount'] as const;
type ChartStatKey = (typeof CHART_STATS_FIELDS)[number];

function parseChartStatPayload(body: Record<string, unknown>): {
  ok: true;
  update: Partial<Record<ChartStatKey, number | null>>;
} | { ok: false; error: string; code: number } {
  const keysPresent = CHART_STATS_FIELDS.filter((k) =>
    Object.prototype.hasOwnProperty.call(body, k),
  );
  if (keysPresent.length === 0) {
    return {
      ok: false,
      code: 400,
      error:
        'Request must include at least one of: bpm, tilecount, levelLengthInMs, autoTileCount',
    };
  }

  const update: Partial<Record<ChartStatKey, number | null>> = {};

  for (const key of keysPresent) {
    const raw = body[key];
    if (raw === null) {
      update[key] = null;
      continue;
    }
    if (raw === '') {
      update[key] = null;
      continue;
    }
    if (typeof raw === 'string' && raw.trim() === '') {
      update[key] = null;
      continue;
    }

    const num = Number(raw);
    if (!Number.isFinite(num)) {
      return {
        ok: false,
        code: 400,
        error: `Invalid value for ${key}: must be a finite number or null`,
      };
    }

    if (key === 'bpm') {
      if (num <= 0) {
        return {
          ok: false,
          code: 400,
          error: 'bpm must be greater than 0 when set',
        };
      }
      update[key] = num;
      continue;
    }

    if (!Number.isInteger(num) || num < 0) {
      return {
        ok: false,
        code: 400,
        error: `${key} must be a non-negative integer when set`,
      };
    }
    update[key] = num;
  }

  return { ok: true, update };
}

function parseXaccCurvePayload(body: Record<string, unknown>): {
  ok: true;
  update: { xaccCurveMeta?: unknown | null };
} | { ok: false; error: string; code: number } {
  if (!Object.prototype.hasOwnProperty.call(body, 'xaccCurveMeta')) {
    return {
      ok: false,
      code: 400,
      error: 'Request must include xaccCurveMeta (null clears to defaults)',
    };
  }

  const raw = body.xaccCurveMeta;
  if (raw === null) {
    return { ok: true, update: { xaccCurveMeta: null } };
  }

  if (!raw || typeof raw !== 'object') {
    return {
      ok: false,
      code: 400,
      error: 'xaccCurveMeta must be an object or null',
    };
  }

  const meta: any = raw;
  const pole = meta.poleOffset;
  const top = meta.topMultiplier;
  if (pole !== undefined || top !== undefined) {
    const paramCheck = validateXaccCurveParams(
      pole !== undefined ? Number(pole) : XACC_CURVE_DEFAULTS.poleOffset,
      top !== undefined ? Number(top) : XACC_CURVE_DEFAULTS.topMultiplier,
    );
    if (!paramCheck.ok) {
      return {
        ok: false,
        code: 400,
        error: paramCheck.error,
      };
    }
  }

  return { ok: true, update: { xaccCurveMeta: meta } };
}

const router = Router();

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

const handleScoreRecalculations = async (
  levelId: number,
  updateData: any,
  transaction: Transaction,
): Promise<PassScoreRecalcResult> => {
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

  const levelRow = await Level.findByPk(levelId, {
    attributes: ['baseScore', 'ppBaseScore', 'xaccCurveMeta', 'diffId'],
    transaction,
  });

  const currentDifficulty = await Difficulty.findByPk(updateData.diffId, {
    transaction,
  });

  if (!currentDifficulty) {
    logger.error(
      `No difficulty found for level ${levelId} with diffId ${updateData.diffId}`,
    );
    return {playerIds: [], passIds: [], updatedCount: 0};
  }

  const levelContext = buildLevelScoreContext(levelRow ?? {}, {
    baseScore: updateData.baseScore ?? levelRow?.baseScore ?? 0,
    ppBaseScore: updateData.ppBaseScore ?? levelRow?.ppBaseScore ?? 0,
    xaccCurveMeta:
      updateData.xaccCurveMeta !== undefined
        ? updateData.xaccCurveMeta
        : (levelRow?.xaccCurveMeta ?? null),
    difficulty: {
      name: currentDifficulty.name,
      baseScore: currentDifficulty.baseScore || 0,
    },
  });

  const passUpdates: Array<{
    id: number;
    levelId: number;
    playerId: number;
    accuracy: number;
    scoreV2: number;
  }> = [];

  for (const passData of passes) {
    const pass = passData.dataValues;
    if (!pass.judgements) continue;

    const {accuracy, scoreV2} = computePassScoreV2(
      {
        speed: pass.speed || 1,
        judgements: pass.judgements,
        isNoHoldTap: pass.isNoHoldTap || false,
      },
      levelContext,
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

  if (passUpdates.length > 0) {
    for (let i = 0; i < passUpdates.length; i += PASS_SCORE_RECALC_BATCH) {
      const chunk = passUpdates.slice(i, i + PASS_SCORE_RECALC_BATCH);
      await Pass.bulkCreate(chunk, {
        updateOnDuplicate: ['accuracy', 'scoreV2'],
        transaction,
      });
    }
    await updateWorldsFirstPPStatus(levelId, transaction);
    logger.debug(`Bulk updated ${passUpdates.length} passes for level ${levelId}`);
  }

  return {
    playerIds: passes.map(pass => pass.playerId),
    passIds: passUpdates.map(pass => pass.id),
    updatedCount: passUpdates.length,
  };
};

/** Reindex + cache + SSE after pass rows are committed. */
async function finalizePassScoreRecalc(
  levelId: number,
  result: PassScoreRecalcResult,
): Promise<void> {
  if (result.passIds.length > 0) {
    await elasticsearchService.reindexPasses(result.passIds);
  }
  if (result.playerIds.length > 0) {
    await elasticsearchService.reindexPlayers(
      Array.from(new Set(result.playerIds)),
    );
  }
  await elasticsearchService.indexLevel(levelId);

  try {
    await CacheInvalidation.invalidateTags([
      `level:${levelId}`,
      'levels:all',
    ]);
  } catch (cacheErr) {
    logger.error(
      `Cache invalidation after pass score recalc failed for level ${levelId}:`,
      cacheErr,
    );
  }

  sseManager.broadcast({ type: 'ratingUpdate' });
  sseManager.broadcast({ type: 'levelUpdate' });
  sseManager.broadcast({
    type: 'passUpdate',
    data: {
      levelId,
      action: 'levelUpdate',
    },
  });
}

/** DB recalc (transaction) then search index + notifications — correct commit order. */
async function executeLevelPassScoreRecalc(
  levelId: number,
  updateData: Record<string, unknown>,
): Promise<PassScoreRecalcResult> {
  let transaction: Transaction | null = null;
  try {
    transaction = await sequelize.transaction({
      isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED,
    });
    const result = await handleScoreRecalculations(
      levelId,
      updateData,
      transaction,
    );
    await transaction.commit();
    transaction = null;
    await finalizePassScoreRecalc(levelId, result);
    return result;
  } catch (error) {
    if (transaction) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        logger.error('Error rolling back pass score recalc:', rollbackErr);
      }
    }
    throw error;
  }
}

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

    if (req.body.suffix !== undefined && req.body.songId === undefined && level.songId) {
      const rebuiltSong = await rebuildLegacySongWhenSuffixChanges(
        level,
        updateData.suffix,
        transaction,
      );
      if (rebuiltSong !== undefined) {
        updateData.song = rebuiltSong;
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
        {
          model: Difficulty,
          as: 'previousDifficulty',
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

    // Preserve associations on a plain snapshot (dataValues alone drops difficulty)
    const oldLevel = {
      ...level.get({plain: true}),
      difficulty: level.difficulty,
      previousDifficulty: level.previousDifficulty,
    } as Level;

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

    if (req.body.suffix !== undefined && req.body.songId === undefined && level.songId) {
      const rebuiltSong = await rebuildLegacySongWhenSuffixChanges(
        level,
        updateData.suffix,
        transaction,
      );
      if (rebuiltSong !== undefined) {
        updateData.song = rebuiltSong;
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
    updateData.isExternallyAvailable = req.body.isExternallyAvailable ?? level.isExternallyAvailable;

    await Level.update(updateData, {
      where: {id: levelId},
      transaction,
    });

    const basescoreTagName = 'Basescore Edit'
    const ppBasescoreTagName = 'Pure Perfect Basescore Edit'
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

    if (updatedLevel) {
      const toRateTransition =
        typeof req.body.toRate === 'boolean' && req.body.toRate !== level.toRate
          ? req.body.toRate
          : null;
      await syncAnnouncementQueueAfterLevelSave({
        oldLevel,
        newLevel: updatedLevel,
        toRateTransition,
        enqueuedBy: req.user?.id ?? null,
        transaction,
      });
    }

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

    // Handle async operations (response already sent)
    void (async () => {
      try {
        if (
          updateData.baseScore !== undefined ||
          updateData.diffId !== undefined
        ) {
          await executeLevelPassScoreRecalc(levelId, updateData);
        }
      } catch (error) {
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

router.delete(
  '/:id([0-9]{1,20})/permanent',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'deleteLevelPermanent',
    summary: 'Permanently delete level',
    description:
      'Hard-delete a soft-deleted level (super admin only). Removes CDN level zip and curation preview assets, destroys the row and dependent data, and deletes the Elasticsearch document.',
    tags: ['Database', 'Levels'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: {
      200: { description: 'Level permanently deleted' },
      400: { description: 'Level is not soft-deleted or invalid request' },
      ...standardErrorResponses404500,
    },
  }),
  async (req: Request, res: Response) => {
    const levelId = parseInt(req.params.id, 10);

    try {
      await executePermanentLevelDeleteWithSideEffects(
        levelId,
        { requireSoftDeleted: true },
        {
          elasticsearchDeleteLevel: async (id) => {
            await elasticsearchService.deleteLevel({ id } as Level);
          },
          broadcastAndInvalidate: async ({ levelId: lid, affectedPlayerIds }) => {
            sseManager.broadcast({ type: 'levelUpdate' });
            sseManager.broadcast({ type: 'ratingUpdate' });
            await CacheInvalidation.invalidateTags([
              `level:${lid}`,
              'levels:all',
              'Passes',
            ]);
            if (affectedPlayerIds.length > 0) {
              await elasticsearchService.reindexPlayers(affectedPlayerIds);
            }
          },
        },
      );

      res.json({
        success: true,
        deleted: { id: levelId },
      });

      return;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg === 'LEVEL_NOT_FOUND') {
        return res.status(404).json({ error: 'Level not found' });
      }
      if (msg === 'LEVEL_NOT_SOFT_DELETED') {
        return res.status(400).json({
          error: 'Level must be soft-deleted before permanent removal',
        });
      }
      logger.error('Error permanently deleting level:', error);
      return res.status(500).json({ error: 'Failed to permanently delete level' });
    }
  },
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

router.patch(
  '/:id([0-9]{1,20})/xacc-curve',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'patchLevelXaccCurve',
    summary: 'Update level xacc score curve meta',
    description:
      'Super admin only. Sets per-level xacc curve meta (including saved pin positions). null clears to site defaults. Recalculates all passes on the level.',
    tags: ['Database', 'Levels'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    requestBody: {
      description:
        'xaccCurveMeta object (or null to clear to defaults)',
      schema: {
        type: 'object',
        properties: {
          xaccCurveMeta: { oneOf: [{ type: 'object' }, { type: 'null' }] },
        },
      },
      required: true,
    },
    responses: {
      200: { description: 'Xacc curve updated' },
      400: { description: 'Invalid body', schema: errorResponseSchema },
      ...standardErrorResponses403404500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const levelId = parseInt(req.params.id, 10);
      const body = req.body as Record<string, unknown>;
      const parsed = parseXaccCurvePayload(body);
      if (!parsed.ok) {
        return res.status(parsed.code).json({ error: parsed.error });
      }

      const level = await Level.findByPk(levelId, {
        attributes: [
          'id',
          'baseScore',
          'ppBaseScore',
          'diffId',
          'xaccCurveMeta',
        ],
      });
      if (!level) {
        return res.status(404).json({ error: 'Level not found' });
      }

      await Level.update(
        { ...parsed.update, updatedAt: new Date() },
        { where: { id: levelId } },
      );

      const updated = await Level.findByPk(levelId, {
        attributes: [
          'id',
          'xaccCurveMeta',
          'baseScore',
          'ppBaseScore',
          'diffId',
        ],
      });

      const recalcPayload = {
        baseScore: updated?.baseScore ?? level.baseScore ?? 0,
        ppBaseScore: updated?.ppBaseScore ?? level.ppBaseScore ?? 0,
        diffId: updated?.diffId ?? level.diffId,
        xaccCurveMeta:
          parsed.update.xaccCurveMeta !== undefined
            ? parsed.update.xaccCurveMeta
            : updated?.xaccCurveMeta ?? null,
      };

      let passesRecalculated = 0;
      try {
        const recalcResult = await executeLevelPassScoreRecalc(
          levelId,
          recalcPayload,
        );
        passesRecalculated = recalcResult.updatedCount;
      } catch (recalcError) {
        logger.error(
          `Error recalculating passes after xacc-curve patch for level ${levelId}:`,
          recalcError,
        );
        return res.status(500).json({
          error:
            'Xacc curve was saved but pass score recalculation failed. Retry or contact an admin.',
          level: updated,
        });
      }

      if (updated) {
        await syncAnnouncementQueueAfterCurveChange({
          levelId,
          beforeLevel: level,
          afterLevel: updated,
          enqueuedBy: req.user?.id ?? null,
        });
      }

      return res.json({
        message: 'Xacc curve updated',
        level: updated,
        passesRecalculated,
      });
    } catch (error) {
      logger.error('Error patching level xacc curve:', error);
      return res.status(500).json({ error: 'Failed to update xacc curve' });
    }
  },
);

router.patch(
  '/:id([0-9]{1,20})/chart-stats',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'patchLevelChartStats',
    summary: 'Update level chart stats (non-CDN)',
    description:
      'Super admin only. Sets bpm, tilecount, levelLengthInMs, and/or autoTileCount for levels whose download is not CDN-managed. CDN levels must use chart sync from the uploaded file.',
    tags: ['Database', 'Levels'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    requestBody: {
      description: 'At least one of bpm, tilecount, levelLengthInMs, autoTileCount (null clears)',
      schema: {
        type: 'object',
        properties: {
          bpm: { oneOf: [{ type: 'number' }, { type: 'null' }] },
          tilecount: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          levelLengthInMs: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          autoTileCount: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
        },
      },
      required: true,
    },
    responses: {
      200: { description: 'Chart stats updated' },
      400: { description: 'Invalid body or CDN-managed level', schema: errorResponseSchema },
      ...standardErrorResponses403404500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const levelId = parseInt(req.params.id, 10);
      const body = req.body as Record<string, unknown>;
      const parsed = parseChartStatPayload(body);
      if (!parsed.ok) {
        return res.status(parsed.code).json({ error: parsed.error });
      }

      const level = await Level.findByPk(levelId, {
        attributes: ['id', 'dlLink'],
      });
      if (!level) {
        return res.status(404).json({ error: 'Level not found' });
      }

      const dl = level.dlLink ?? '';
      if (dl && isCdnUrl(dl)) {
        return res.status(400).json({
          error:
            'Chart stats for CDN-managed levels are derived from the uploaded file. Use upload management to change the file.',
        });
      }

      await Level.update(
        {...parsed.update, updatedAt: new Date()},
        {where: {id: levelId}},
      );

      const updated = await Level.findByPk(levelId, {
        attributes: ['id', 'bpm', 'tilecount', 'levelLengthInMs', 'autoTileCount'],
      });

      await elasticsearchService.indexLevel(levelId);
      try {
        await CacheInvalidation.invalidateTags([
          `level:${levelId}`,
          'levels:all',
        ]);
      } catch (cacheErr) {
        logger.error(
          `Cache invalidation after chart-stats patch failed for level ${levelId}:`,
          cacheErr,
        );
      }

      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      (async () => {
        try {
          sseManager.broadcast({type: 'levelUpdate'});
        } catch (error) {
          logger.error(
            'Error broadcasting after chart-stats patch:',
            error,
          );
        }
      })();

      return res.json({
        message: 'Chart stats updated',
        level: updated,
      });
    } catch (error) {
      logger.error('Error patching level chart stats:', error);
      return res.status(500).json({error: 'Failed to update chart stats'});
    }
  },
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

// Swap chart/metadata payload between two levels and remap child levelIds (except likes)
router.post(
  '/:id([0-9]{1,20})/swap-payload',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'postLevelSwapPayload',
    summary: 'Swap level payloads',
    description:
      'Exchange chart/metadata columns between two levels while keeping both IDs fixed, then remap child levelIds (passes, ratings, credits, packs, tags, curations, etc.). level_likes are not remapped.',
    tags: ['Database', 'Levels'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    requestBody: {
      description: 'targetLevelId: other level to swap payload with',
      schema: {
        type: 'object',
        properties: { targetLevelId: { type: 'integer' } },
        required: ['targetLevelId'],
      },
      required: true,
    },
    responses: {
      200: { description: 'Payloads swapped' },
      ...standardErrorResponses,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = parseInt(req.params.id, 10);
      const targetId = parseInt(String(req.body?.targetLevelId), 10);

      const { levelA, levelB, sourceId: a, targetId: b } =
        await executeLevelPayloadSwap(sourceId, targetId);

      void (async () => {
        try {
          const [passIdsA, passIdsB] = await Promise.all([
            getPassIdsByLevelId(a),
            getPassIdsByLevelId(b),
          ]);
          const passIds = [...new Set([...passIdsA, ...passIdsB])];
          await Promise.all([
            elasticsearchService.indexLevel(a),
            elasticsearchService.indexLevel(b),
            passIds.length > 0
              ? elasticsearchService.reindexPasses(passIds)
              : Promise.resolve(),
            CacheInvalidation.invalidateTags([
              `level:${a}`,
              `level:${b}`,
              'levels:all',
            ]),
            invalidatePackLevelsCachesForLevelIds([a, b]),
          ]);
        } catch (err) {
          logger.error('Error reindexing/invalidating after level payload swap:', err);
        }
      })();

      return res.json({ levelA, levelB });
    } catch (error) {
      if (error instanceof LevelPayloadSwapError) {
        if (error.code === 'NOT_FOUND') {
          return res.status(404).json({ error: error.message });
        }
        return res.status(400).json({ error: error.message });
      }
      logger.error('Error swapping level payloads:', error);
      return res.status(500).json({ error: 'Failed to swap level payloads' });
    }
  },
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
