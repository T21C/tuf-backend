import { Op, Transaction } from 'sequelize';
import sequelize from '@/config/db.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { safeTransactionRollback } from '@/misc/utils/Utility.js';
import {
  PassSubmission,
  PassSubmissionFlags,
  PassSubmissionJudgements,
} from '@/models/submissions/PassSubmission.js';
import Pass from '@/models/passes/Pass.js';
import Level from '@/models/levels/Level.js';
import Difficulty from '@/models/levels/Difficulty.js';
import Judgement from '@/models/passes/Judgement.js';
import {
  computePassScoreV2,
  PassScoreCalculationError,
} from '@/misc/utils/pass/scoreService.js';
import { deriveKeyFlags, normalizeKeyCount } from '@/misc/utils/pass/keyCount.js';
import { PlayerStatsService } from '@/server/services/core/PlayerStatsService.js';
import { updateWorldsFirstFlags } from '@/server/routes/v2/database/passes/index.js';
import type { IPassSubmissionJudgements } from '@/server/interfaces/models/index.js';
import LevelSubmission from '@/models/submissions/LevelSubmission.js';
import Rating from '@/models/levels/Rating.js';
import Player from '@/models/players/Player.js';
import Team from '@/models/credits/Team.js';
import LevelSubmissionCreatorRequest from '@/models/submissions/LevelSubmissionCreatorRequest.js';
import LevelSubmissionTeamRequest from '@/models/submissions/LevelSubmissionTeamRequest.js';
import Creator from '@/models/credits/Creator.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import User from '@/models/auth/User.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import { applyLevelChartStatsFromCdn } from '@/misc/utils/data/levelChartStatsSync.js';
import { CDN_CONFIG } from '@/externalServices/cdnService/config.js';
import cdnService from '@/server/services/core/CdnService.js';
import { tagAssignmentService } from '@/server/services/data/TagAssignmentService.js';
import { autoraterService } from '@/server/services/data/AutoraterService.js';
import LevelSubmissionSongRequest from '@/models/submissions/LevelSubmissionSongRequest.js';
import LevelSubmissionArtistRequest from '@/models/submissions/LevelSubmissionArtistRequest.js';
import LevelSubmissionEvidence from '@/models/submissions/LevelSubmissionEvidence.js';
import Song from '@/models/songs/Song.js';
import Artist from '@/models/artists/Artist.js';
import SongCredit from '@/models/songs/SongCredit.js';
import ArtistService from '@/server/services/data/ArtistService.js';
import {
  resolveOrCreateTeamByName,
  TeamMutationError,
} from '@/server/services/teams/teamMutations.js';
import SongService from '@/server/services/data/SongService.js';
import EvidenceService from '@/server/services/data/EvidenceService.js';
import { roleSyncService } from '@/server/services/accounts/RoleSyncService.js';
import { notifyPassSubmissionOutcome } from '@/server/services/notifications/passSubmissionNotify.js';
import { notifyChartCleared } from '@/server/services/notifications/chartClearNotify.js';
import { notifyChartSubmission } from '@/server/services/notifications/levelSubmissionNotify.js';
import { resolveLevelCreatedAtFromVideoLink } from '@/misc/utils/data/levelCreatedAtFromVideoLink.js';
import { getSongDisplayName } from '@/misc/utils/data/levelHelpers.js';
import { CacheInvalidation } from '@/server/middleware/cache.js';
import { broadcastRatingUpsert } from '@/server/services/ratings/ratingListService.js';
import type { SubmissionQueuePayload } from './submissionJobTypes.js';

const elasticsearchService = ElasticsearchService.getInstance();
const playerStatsService = PlayerStatsService.getInstance();
const artistService = ArtistService.getInstance();
const songService = SongService.getInstance();
const evidenceService = EvidenceService.getInstance();

type OnStep = (stepId: string) => Promise<void>;

function isValidNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(value);
}

const LEVEL_APPROVE_INCLUDES = [
  { model: LevelSubmissionCreatorRequest, as: 'creatorRequests' },
  { model: LevelSubmissionTeamRequest, as: 'teamRequestData' },
  { model: LevelSubmissionSongRequest, as: 'songRequest' },
  { model: LevelSubmissionArtistRequest, as: 'artistRequests' },
  { model: LevelSubmissionEvidence, as: 'evidence' },
  {
    model: Song,
    as: 'songObject',
    include: [
      {
        model: SongCredit,
        as: 'credits',
        include: [{ model: Artist, as: 'artist', attributes: ['id', 'name'] }],
        required: false,
      },
    ],
  },
  { model: Artist, as: 'artistObject' },
];

const PASS_APPROVE_INCLUDES = [
  {
    model: Level,
    as: 'level',
    include: [
      { model: Difficulty, as: 'difficulty' },
      {
        model: LevelCredit,
        as: 'levelCredits',
        include: [{ model: Creator, as: 'creator' }],
      },
    ],
  },
  { model: Player, as: 'assignedPlayer' },
  { model: PassSubmissionFlags, as: 'flags' },
  { model: PassSubmissionJudgements, as: 'judgements' },
];

async function processLevelApprove(
  submissionId: number,
  actorId: string | null,
  onStep: OnStep,
): Promise<{ levelId?: number | null; passId?: number | null }> {
  await onStep('validate');
  let transaction: Transaction | undefined;
  try {
    transaction = await sequelize.transaction();
    const submissionObj = await LevelSubmission.findOne({
      where: { [Op.and]: [{ id: submissionId }, { status: 'pending' }] },
      include: LEVEL_APPROVE_INCLUDES,
      transaction,
    });
    if (!submissionObj) {
      throw new Error('Submission not found');
    }
    if (submissionObj.isLocked) {
      throw new Error('Submission is locked');
    }

    const hasUnhandledCreators = submissionObj.creatorRequests?.some(
      request => !request.creatorId && !request.isNewRequest,
    );
    if (hasUnhandledCreators) {
      throw new Error('All creators must be either assigned to existing creators or marked as new creators');
    }
    if (
      submissionObj.teamRequestData
      && !submissionObj.teamRequestData.teamId
      && !submissionObj.teamRequestData.isNewRequest
    ) {
      throw new Error('Team must be either assigned to an existing team or marked as a new team');
    }

    await onStep('resolveEntities');
    const submission = submissionObj.dataValues;
    const firstCharter = submission.creatorRequests?.find(
      (r: LevelSubmissionCreatorRequest) => r.role === 'charter',
    );
    const firstVfxer = submission.creatorRequests?.find(
      (r: LevelSubmissionCreatorRequest) => r.role === 'vfxer',
    );

    let teamId = null;
    let team = null;
    if (submission.teamRequestData) {
      if (submission.teamRequestData.teamId) {
        team = await Team.findByPk(submission.teamRequestData.teamId, { transaction });
        if (!team) throw new Error('Referenced team not found');
        teamId = team.id;
      } else if (submission.teamRequestData.isNewRequest) {
        try {
          team = await resolveOrCreateTeamByName(
            submission.teamRequestData.teamName.trim(),
            transaction,
          );
        } catch (error) {
          if (error instanceof TeamMutationError) throw new Error(error.message);
          throw error;
        }
        teamId = team.id;
      }
    }

    if (submission.songRequest) {
      const hasSongId = !!submission.songRequest.songId;
      const hasNewSongRequest = submission.songRequest.isNewRequest && !!submission.songRequest.songName;
      if (!hasSongId && !hasNewSongRequest) {
        throw new Error('Song request is incomplete. Please either assign an existing song or mark it as a new song request with a name.');
      }
    }

    let finalSongId: number | null = null;
    let preResolvedArtistIdsForNewSongFlow: number[] | undefined;
    if (submission.songRequest) {
      if (submission.songRequest.songId) {
        finalSongId = submission.songRequest.songId;
      } else if (submission.songRequest.isNewRequest && submission.songRequest.songName) {
        const verificationState = submission.songRequest.verificationState || 'pending';
        const trimmedName = submission.songRequest.songName.trim();
        const resolvedArtistIds =
          await artistService.resolveArtistIdsFromLevelSubmissionArtistRequests(submission);
        preResolvedArtistIdsForNewSongFlow = resolvedArtistIds;

        let song: Song;
        if (resolvedArtistIds.length > 0) {
          const existingSong = await songService.findSongByNameAndCreditArtistSet(
            trimmedName,
            resolvedArtistIds,
            transaction,
          );
          song = existingSong || await Song.create(
            { name: trimmedName, verificationState },
            { transaction },
          );
        } else {
          const [createdOrFound] = await Song.findOrCreate({
            where: { name: trimmedName },
            defaults: { name: trimmedName, verificationState },
            transaction,
          });
          song = createdOrFound;
        }
        finalSongId = song.id;
      }
    } else if (submission.songId) {
      finalSongId = submission.songId;
    }

    if (!(finalSongId && submission.songObject?.credits)) {
      if (submission.artistRequests && submission.artistRequests.length > 0) {
        for (const artistRequest of submission.artistRequests) {
          const hasArtistId = !!artistRequest.artistId;
          const hasNewArtistRequest = artistRequest.isNewRequest && !!artistRequest.artistName;
          if (!hasArtistId && !hasNewArtistRequest) {
            throw new Error('Artist request is incomplete. Please either assign an existing artist or mark it as a new artist request with a name.');
          }
        }
      }
    }

    let finalArtistIds: number[] = [];
    let finalArtistString = '';
    if (finalSongId && submission.songObject?.credits) {
      for (const credit of submission.songObject.credits || []) {
        if (credit.artist?.id) finalArtistIds.push(credit.artist.id);
      }
      finalArtistString = (submission.songObject.credits || [])
        .map((credit: { artist?: { name?: string } }) => credit.artist?.name)
        .filter((name: string | undefined): name is string => !!name)
        .join(' & ');
    } else {
      if (preResolvedArtistIdsForNewSongFlow !== undefined) {
        finalArtistIds = [...preResolvedArtistIdsForNewSongFlow];
      } else if (submission.artistRequests && submission.artistRequests.length > 0) {
        for (const artistRequest of submission.artistRequests) {
          if (artistRequest.artistId) {
            finalArtistIds.push(artistRequest.artistId);
          } else if (artistRequest.isNewRequest && artistRequest.artistName) {
            const verificationState = artistRequest.verificationState || 'unverified';
            const artist = await artistService.findOrCreateArtist(
              artistRequest.artistName.trim(),
              undefined,
              verificationState as Artist['verificationState'],
            );
            finalArtistIds.push(artist.id);
          }
        }
      } else if (submission.artistId) {
        finalArtistIds.push(submission.artistId);
      }

      if (finalArtistIds.length > 0) {
        const artists = await Artist.findAll({
          where: { id: finalArtistIds },
          attributes: ['id', 'name'],
          transaction,
        });
        finalArtistString = artists.map(a => a.name).join(' & ');
      } else {
        finalArtistString = submission.artist || '';
      }
    }

    if (submission.songRequest && !finalSongId) {
      throw new Error('Failed to resolve song from song request. Please ensure the song request is properly configured.');
    }
    if (!(finalSongId && submission.songObject?.credits)) {
      if (submission.artistRequests && submission.artistRequests.length > 0 && finalArtistIds.length === 0) {
        throw new Error('Failed to resolve artists from artist requests. Please ensure all artist requests are properly configured.');
      }
    }

    if (finalSongId && finalArtistIds.length > 0 && !submission.songObject?.credits) {
      for (const artistId of finalArtistIds) {
        const existingCredit = await SongCredit.findOne({
          where: { songId: finalSongId, artistId },
          transaction,
        });
        if (!existingCredit) {
          await SongCredit.create(
            { songId: finalSongId, artistId, role: null },
            { transaction },
          );
        }
      }
    }

    await onStep('createLevel');
    const levelCreatedAtFromVideo = await resolveLevelCreatedAtFromVideoLink(submission.videoLink);
    const legacySongName =
      submission.songObject && finalSongId
        ? getSongDisplayName({
            songObject: submission.songObject,
            suffix: submission.suffix ?? null,
          })
        : submission.suffix
          ? `${submission.song} ${submission.suffix}`
          : submission.song;

    const newLevel = await Level.create(
      {
        song: legacySongName,
        artist: finalArtistString || submission.artist || '',
        suffix: submission.suffix || null,
        songId: finalSongId,
        charter: firstCharter?.creatorName || '',
        vfxer: firstVfxer?.creatorName || '',
        team: team?.name || '',
        videoLink: submission.videoLink,
        dlLink: submission.directDL,
        workshopLink: submission.wsLink,
        toRate: true,
        isDeleted: false,
        diffId: 0,
        baseScore: 0,
        clears: 0,
        likes: 0,
        publicComments: '',
        notes: submission.notes || '',
        rerateReason: '',
        rerateNum: '',
        previousDiffId: 0,
        isAnnounced: false,
        isHidden: false,
        teamId,
        isExternallyAvailable: false,
        ...(levelCreatedAtFromVideo ? { createdAt: levelCreatedAtFromVideo } : {}),
      },
      { transaction },
    );

    const lowRatingRegex = /^[pP]\d|^[1-9]$|^1[0-9]\+?$|^([1-9]|1[0-9]\+?)(~|-)([1-9]|1[0-9]\+?)$/;
    const newRating = await Rating.create(
      {
        levelId: newLevel.id,
        lowDiff: lowRatingRegex.test(submission.diff),
        requesterFR: submission.diff,
        averageDifficultyId: null,
      },
      { transaction },
    );

    let actorCreatorId: number | null = null;
    if (actorId) {
      const actor = await User.findByPk(actorId, { attributes: ['creatorId'], transaction });
      actorCreatorId = actor?.creatorId ?? null;
    }

    for (const request of submission.creatorRequests || []) {
      if (request.creatorId) {
        const isOwner = request.id === actorCreatorId;
        const existingCredit = await LevelCredit.findOne({
          where: { levelId: newLevel.id, creatorId: request.creatorId, role: request.role },
          transaction,
        });
        if (!existingCredit) {
          await LevelCredit.create(
            { levelId: newLevel.id, creatorId: request.creatorId, role: request.role, isOwner },
            { transaction },
          );
        }
      } else if (request.isNewRequest) {
        const [creator] = await Creator.findOrCreate({
          where: { name: request.creatorName.trim() },
          defaults: { verificationStatus: 'pending' },
          transaction,
        });
        const existingCredit = await LevelCredit.findOne({
          where: { levelId: newLevel.id, creatorId: creator.id, role: request.role },
          transaction,
        });
        if (!existingCredit) {
          await LevelCredit.create(
            { levelId: newLevel.id, creatorId: creator.id, role: request.role },
            { transaction },
          );
        }
      }
    }

    await LevelSubmission.update(
      { status: 'approved', toRate: true },
      { where: { id: submissionId }, transaction },
    );

    await onStep('notify');
    await notifyChartSubmission({
      outcome: 'approved',
      submissionId,
      userId: submission.userId,
      level: { id: newLevel.id, song: newLevel.song, artist: newLevel.artist },
      actorId,
      transaction,
    });

    if (submission.evidence && submission.evidence.length > 0) {
      for (const evidence of submission.evidence) {
        if (evidence.type === 'song' && finalSongId) {
          await evidenceService.addEvidenceToSong(finalSongId, evidence.link, transaction);
        } else if (evidence.type === 'artist' && finalArtistIds.length > 0) {
          for (const artistId of finalArtistIds) {
            await evidenceService.addEvidenceToArtist(artistId, evidence.link, transaction);
          }
        }
      }
    }

    await transaction.commit();
    transaction = undefined;

    await CacheInvalidation.invalidateTag('admin:ratings').catch(err =>
      logger.warn('Failed to invalidate admin:ratings cache after level approve', {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    await broadcastRatingUpsert(newRating.id, newLevel.id).catch(err =>
      logger.warn('Failed to broadcast rating upsert after level approve', {
        levelId: newLevel.id,
        ratingId: newRating.id,
        error: err instanceof Error ? err.message : String(err),
      }),
    );

    await onStep('chartStats');
    try {
      await applyLevelChartStatsFromCdn(newLevel.id);
    } catch (statsError) {
      logger.warn('Failed to apply CDN chart stats after level approve', {
        levelId: newLevel.id,
        error: statsError instanceof Error ? statsError.message : String(statsError),
      });
    }

    await onStep('autoTags');
    try {
      const tagResult = await tagAssignmentService.assignAutoTags(newLevel.id);
      if (tagResult.assignedTags.length > 0) {
        await elasticsearchService.reindexLevels([newLevel.id]);
      }
    } catch (tagError) {
      logger.warn('Failed to assign auto tags to new level:', {
        levelId: newLevel.id,
        error: tagError instanceof Error ? tagError.message : String(tagError),
      });
    }

    void autoraterService.autorateRating(newRating.id).catch(err => {
      logger.warn('Failed to auto-autorate new level submission rating', {
        levelId: newLevel.id,
        ratingId: newRating.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return { levelId: newLevel.id };
  } catch (error) {
    if (transaction) await safeTransactionRollback(transaction, logger);
    throw error;
  }
}

async function processLevelDecline(
  submissionId: number,
  actorId: string | null,
  onStep: OnStep,
  reason: string | null = null,
): Promise<void> {
  await onStep('validate');
  let transaction: Transaction | undefined;
  try {
    transaction = await sequelize.transaction();
    const submission = await LevelSubmission.findByPk(submissionId, {
      include: [{ model: LevelSubmissionEvidence, as: 'evidence' }],
      transaction,
    });
    if (!submission) throw new Error('Submission not found');
    if (submission.status !== 'pending') throw new Error('Submission not found');
    if (submission.isLocked) throw new Error('Submission is locked');

    await onStep('cleanup');
    if (submission.directDL && submission.directDL.includes(CDN_CONFIG.baseUrl)) {
      const urlParts = submission.directDL.split('/');
      const fileId = urlParts[urlParts.length - 1];
      if (fileId) {
        try {
          await cdnService.deleteFile(fileId);
        } catch (error) {
          logger.warn('Failed to delete CDN file on decline:', error);
        }
      }
    }
    const submissionWithEvidence = submission as LevelSubmission & { evidence?: LevelSubmissionEvidence[] };
    if (submissionWithEvidence.evidence && submissionWithEvidence.evidence.length > 0) {
      await evidenceService.deleteAllEvidenceForSubmission(submissionId);
    }

    await LevelSubmission.update({ status: 'declined' }, { where: { id: submissionId }, transaction });

    await onStep('notify');
    await notifyChartSubmission({
      outcome: 'declined',
      submissionId,
      userId: submission.userId,
      level: { song: submission.song, artist: submission.artist },
      actorId,
      reason,
      transaction,
    });

    await transaction.commit();
  } catch (error) {
    if (transaction) await safeTransactionRollback(transaction, logger);
    throw error;
  }
}

async function approvePassSubmission(
  submissionId: number,
  transaction: Transaction,
  actorId?: string | null,
): Promise<{ newPass: Pass; createdRatingId: number | null; assignedPlayerId: number | null; levelId: number | null }> {
  const submission = await PassSubmission.findByPk(submissionId, {
    include: [
      { model: Level, as: 'level', include: [{ model: Difficulty, as: 'difficulty' }] },
      { model: Player, as: 'assignedPlayer' },
      { model: PassSubmissionJudgements, as: 'judgements' },
      { model: PassSubmissionFlags, as: 'flags' },
    ],
    transaction,
  });
  if (!submission) throw new Error('Submission not found');
  const submissionData = submission.toJSON() as { passId?: number };
  if (submissionData.passId) {
    throw new Error(`Pass already exists for this submission (passId: ${submissionData.passId})`);
  }
  if (!submission.level) throw new Error('Level data not found for this submission');
  if (!submission.level.difficulty) {
    throw new Error('Level difficulty not found - level may need to be rated first');
  }
  if (!submission.assignedPlayerId) throw new Error('No player assigned to this submission');

  const player = await Player.findByPk(submission.assignedPlayerId, { transaction });
  if (!player) throw new Error('Assigned player does not exist');
  if (!submission.judgements) throw new Error('Judgements data not found for this submission');
  if (!submission.flags) throw new Error('Flags data not found for this submission');
  if (!submission.levelId || !isValidNumber(submission.levelId)) {
    throw new Error('Invalid level ID');
  }

  const flags = submission.flags;
  const judgements = submission.judgements;
  const level = submission.level;
  const difficulty = level.difficulty;
  const judgementData = {
    earlyDouble: judgements.earlyDouble || 0,
    earlySingle: judgements.earlySingle || 0,
    ePerfect: judgements.ePerfect || 0,
    perfect: judgements.perfect || 0,
    lPerfect: judgements.lPerfect || 0,
    lateSingle: judgements.lateSingle || 0,
    lateDouble: judgements.lateDouble || 0,
  };
  const speed = submission.speed || 1;
  let accuracy: number;
  let scoreV2: number;
  try {
    ({ accuracy, scoreV2 } = computePassScoreV2(
      {
        speed,
        judgements: judgementData as IPassSubmissionJudgements,
        isNoHoldTap: flags.isNoHoldTap || false,
      },
      level,
    ));
  } catch (err) {
    if (err instanceof PassScoreCalculationError) throw new Error(err.message);
    throw err;
  }
  if (!isValidNumber(accuracy)) throw new Error('Failed to calculate valid accuracy from judgements');
  if (!isValidNumber(scoreV2)) {
    throw new Error('Failed to calculate valid score - check level base score and difficulty');
  }

  const submissionKeyCount = normalizeKeyCount(submission.keyCount);
  const keyFlags =
    submissionKeyCount !== null
      ? deriveKeyFlags(submissionKeyCount)
      : { is12K: flags.is12K || false, is16K: flags.is16K || false };

  const pass = await Pass.create({
    levelId: submission.levelId,
    playerId: submission.assignedPlayerId,
    speed,
    vidTitle: submission.title || '',
    videoLink: submission.videoLink,
    vidUploadTime: submission.rawTime || new Date(),
    keyCount: submissionKeyCount,
    is12K: keyFlags.is12K,
    is16K: keyFlags.is16K,
    isNoHoldTap: flags.isNoHoldTap || false,
    isAdofaiV2: flags.isAdofaiV2 || false,
    feelingRating: submission.feelingDifficulty || null,
    expectedRating: submission.expectedDifficulty || null,
    accuracy,
    scoreV2,
    isAnnounced: false,
    isDeleted: false,
  }, { transaction });

  const now = new Date();
  const judgementRecord = await Judgement.create(
    { id: pass.id, ...judgementData, createdAt: now, updatedAt: now },
    { transaction },
  );
  if (!judgementRecord) throw new Error(`Failed to create judgement record for pass #${pass.id}`);

  await submission.update({ status: 'approved', passId: pass.id }, { transaction });
  await updateWorldsFirstFlags(submission.levelId, transaction);

  const newPass = await Pass.findByPk(pass.id, {
    include: [
      { model: Player, as: 'player' },
      {
        model: Level,
        as: 'level',
        include: [
          { model: Difficulty, as: 'difficulty' },
          { model: LevelCredit, as: 'levelCredits', include: [{ model: Creator, as: 'creator' }] },
        ],
      },
      { model: Judgement, as: 'judgements' },
    ],
    transaction,
  });
  if (!newPass) throw new Error(`Failed to fetch created pass #${pass.id}`);

  try {
    await elasticsearchService.reindexPlayers([submission.assignedPlayerId]);
    await playerStatsService.getPlayerStats(submission.assignedPlayerId);
  } catch (statsError) {
    logger.warn('Failed to update player stats during approval', {
      submissionId: submission.id,
      playerId: submission.assignedPlayerId,
      error: statsError instanceof Error ? statsError.message : String(statsError),
    });
  }

  let createdRatingId: number | null = null;
  if (level.clears === 0 && difficulty.name.includes('Q') && speed === 1) {
    let reqFr = submission.feelingDifficulty ?? '';
    if (difficulty.name.includes('UQ')) {
      reqFr = `vote (${submission.feelingDifficulty ?? ''})`;
    }
    const newRating = await Rating.create(
      { levelId: submission.levelId, lowDiff: false, requesterFR: submission.feelingDifficulty?.substring(0, 60) || 'cleared' },
      { transaction },
    );
    createdRatingId = newRating.id;
    await Level.update({
      toRate: true,
      previousDiffId: level.diffId,
      previousBaseScore: level.baseScore || difficulty.baseScore || 0,
      rerateNum: reqFr.substring(0, 60) || '',
      rerateReason: 'cleared',
    }, { where: { id: submission.levelId }, transaction });
  }

  await notifyPassSubmissionOutcome({
    submission,
    outcome: 'approved',
    passId: pass.id,
    actorId: actorId ?? null,
    transaction,
  });

  await notifyChartCleared({
    level: level,
    passId: pass.id,
    playerId: submission.assignedPlayerId,
    playerName: player.name ?? null,
    transaction,
  });

  return {
    newPass: newPass as Pass,
    createdRatingId,
    assignedPlayerId: submission.assignedPlayerId,
    levelId: submission.levelId,
  };
}

async function processPassApprove(
  submissionId: number,
  actorId: string | null,
  onStep: OnStep,
): Promise<{ levelId?: number | null; passId?: number | null }> {
  await onStep('validate');
  let transaction: Transaction | undefined;
  try {
    transaction = await sequelize.transaction();
    const submission = await PassSubmission.findOne({
      where: { [Op.and]: [{ id: submissionId }, { status: 'pending' }] },
      include: PASS_APPROVE_INCLUDES,
      lock: true,
      transaction,
    });
    if (!submission) throw new Error('Submission not found or already processed');
    if (submission.isLocked) throw new Error('Submission is locked');

    await onStep('createPass');
    const { newPass, createdRatingId, assignedPlayerId, levelId } = await approvePassSubmission(
      submission.id,
      transaction,
      actorId,
    );
    await transaction.commit();
    transaction = undefined;

    await onStep('index');
    try {
      await elasticsearchService.indexPass(newPass);
      if (newPass.level) await elasticsearchService.indexLevel(newPass.level);
    } catch (indexError) {
      logger.warn('Failed to index pass after approval', {
        passId: newPass.id,
        error: indexError instanceof Error ? indexError.message : String(indexError),
      });
    }

    if (createdRatingId && levelId) {
      await CacheInvalidation.invalidateTag('admin:ratings').catch(err =>
        logger.warn('Failed to invalidate admin:ratings cache after pass approve', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      await broadcastRatingUpsert(createdRatingId, levelId).catch(err =>
        logger.warn('Failed to broadcast rating upsert after pass approve', {
          levelId,
          ratingId: createdRatingId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }

    await onStep('roleSync');
    if (assignedPlayerId) {
      try {
        const discordId = await roleSyncService.getDiscordIdForPlayer(assignedPlayerId);
        if (discordId) {
          await roleSyncService.notifyBotOfRoleSyncByDiscordIds([discordId]).catch(() => undefined);
        }
      } catch (err) {
        logger.debug(`[submissions] Failed to notify bot of role sync: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { levelId, passId: newPass.id };
  } catch (error) {
    if (transaction) await safeTransactionRollback(transaction, logger);
    throw error;
  }
}

async function processPassDecline(
  submissionId: number,
  actorId: string | null,
  onStep: OnStep,
  reason: string | null = null,
): Promise<{ levelId?: number | null; passId?: number | null }> {
  await onStep('validate');
  let transaction: Transaction | undefined;
  try {
    transaction = await sequelize.transaction();
    const submission = await PassSubmission.findOne({
      where: { [Op.and]: [{ id: submissionId }, { status: 'pending' }] },
      include: [{ model: Level, as: 'level' }],
      lock: true,
      transaction,
    });
    if (!submission) throw new Error('Submission not found or already processed');
    if (submission.isLocked) throw new Error('Submission is locked');

    await onStep('notify');
    await submission.update({ status: 'declined' }, { transaction });
    await notifyPassSubmissionOutcome({
      submission,
      outcome: 'declined',
      passId: null,
      actorId,
      reason,
      transaction,
    });
    await transaction.commit();
    return { levelId: submission.levelId ?? null };
  } catch (error) {
    if (transaction) await safeTransactionRollback(transaction, logger);
    throw error;
  }
}

export async function processQueuedSubmission(
  payload: SubmissionQueuePayload,
  onStep: OnStep,
): Promise<{ levelId?: number | null; passId?: number | null }> {
  if (payload.kind === 'level' && payload.action === 'approve') {
    return processLevelApprove(payload.itemId, payload.actorId, onStep);
  }
  if (payload.kind === 'level' && payload.action === 'decline') {
    await processLevelDecline(payload.itemId, payload.actorId, onStep, payload.reason ?? null);
    return {};
  }
  if (payload.kind === 'pass' && payload.action === 'approve') {
    return processPassApprove(payload.itemId, payload.actorId, onStep);
  }
  return processPassDecline(payload.itemId, payload.actorId, onStep, payload.reason ?? null);
}
