import {Request, Response, Router} from 'express';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import { standardErrorResponses, standardErrorResponses404500, standardErrorResponses500, stringIdParamSpec } from '@/server/schemas/v2/admin/index.js';
import {
  PassSubmission,
  PassSubmissionFlags,
  PassSubmissionJudgements,
} from '@/models/submissions/PassSubmission.js';
import Pass from '@/models/passes/Pass.js';
import Level from '@/models/levels/Level.js';
import Difficulty from '@/models/levels/Difficulty.js';
import Judgement from '@/models/passes/Judgement.js';
import {calcAcc} from '@/misc/utils/pass/CalcAcc.js';
import {getScoreV2} from '@/misc/utils/pass/CalcScore.js';
import {getIO} from '@/misc/utils/server/socket.js';
import sequelize from '@/config/db.js';
import {sseManager} from '@/misc/utils/server/sse.js';
import {PlayerStatsService} from '@/server/services/core/PlayerStatsService.js';
import {updateWorldsFirstStatus} from '@/server/routes/v2/database/passes/index.js';
import {IPassSubmissionJudgements} from '@/server/interfaces/models/index.js';
import LevelSubmission from '@/models/submissions/LevelSubmission.js';
import Rating from '@/models/levels/Rating.js';
import Player from '@/models/players/Player.js';
import Team from '@/models/credits/Team.js';
import LevelSubmissionCreatorRequest from '@/models/submissions/LevelSubmissionCreatorRequest.js';
import LevelSubmissionTeamRequest from '@/models/submissions/LevelSubmissionTeamRequest.js';
import Creator from '@/models/credits/Creator.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import User from '@/models/auth/User.js';
import { Op, Transaction } from 'sequelize';
import { logger } from '@/server/services/core/LoggerService.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import { applyLevelChartStatsFromCdn } from '@/misc/utils/data/levelChartStatsSync.js';
import { CDN_CONFIG } from '@/externalServices/cdnService/config.js';
import cdnService from '@/server/services/core/CdnService.js';
import { safeTransactionRollback } from '@/misc/utils/Utility.js';
import {TeamAlias} from '@/models/credits/TeamAlias.js';
import {tagAssignmentService} from '@/server/services/data/TagAssignmentService.js';
import LevelSubmissionSongRequest from '@/models/submissions/LevelSubmissionSongRequest.js';
import LevelSubmissionArtistRequest from '@/models/submissions/LevelSubmissionArtistRequest.js';
import LevelSubmissionEvidence from '@/models/submissions/LevelSubmissionEvidence.js';
import Song from '@/models/songs/Song.js';
import Artist from '@/models/artists/Artist.js';
import SongCredit from '@/models/songs/SongCredit.js';
import ArtistService from '@/server/services/data/ArtistService.js';
import EvidenceService from '@/server/services/data/EvidenceService.js';
import submissionSongArtistRoutes from './submissions-song-artist.js';
import { roleSyncService } from '@/server/services/accounts/RoleSyncService.js';
import { sanitizeJudgementInt } from '@/misc/utils/pass/SanitizeJudgements.js';

const router: Router = Router();
const playerStatsService = PlayerStatsService.getInstance();
const elasticsearchService = ElasticsearchService.getInstance();
const artistService = ArtistService.getInstance();
const evidenceService = EvidenceService.getInstance();

enum CreditRole {
  CHARTER = 'charter',
  VFXER = 'vfxer',
  TEAM = 'team'
}

/**
 * Extracts meaningful error information from Sequelize/database errors
 */
function extractErrorDetails(error: unknown): {
  message: string;
  sql?: string;
  original?: string;
  fields?: Record<string, unknown>;
} {
  if (error instanceof Error) {
    const seqError = error as any;
    return {
      message: error.message,
      sql: seqError.sql,
      original: seqError.original?.message || seqError.parent?.message,
      fields: seqError.fields,
    };
  }
  return { message: String(error) };
}

/**
 * Validates a number is finite and not NaN
 */
function isValidNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(value);
}

/** Include config for pass submission approval - used by both single approve and auto-approve */
const PASS_SUBMISSION_APPROVE_INCLUDES = [
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

/** Full include for admin pass submission PATCH response (matches assign-player reload + passSubmitter) */
const PASS_SUBMISSION_ADMIN_PUT_INCLUDES = [
  {
    model: Player,
    as: 'assignedPlayer',
  },
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
  { model: PassSubmissionJudgements, as: 'judgements' },
  { model: PassSubmissionFlags, as: 'flags' },
  {
    model: User,
    as: 'passSubmitter',
    required: false,
    attributes: ['id', 'username', 'playerId'],
  },
];

const JUDGEMENT_FIELD_KEYS = [
  'earlyDouble',
  'earlySingle',
  'ePerfect',
  'perfect',
  'lPerfect',
  'lateSingle',
  'lateDouble',
] as const;

function validateSpeedFloatInput(input: unknown): number {
  const parsed = parseFloat(String(input ?? '1'));
  if (Number.isNaN(parsed)) return 1;
  return Math.max(1, Math.min(100, parsed));
}

interface ApprovePassSubmissionResult {
  pass: Pass;
  newPass: Pass;
  playerStats: Awaited<ReturnType<typeof playerStatsService.getPlayerStats>>[0] | null;
}

/**
 * Core logic to approve a pass submission. Validates, calculates, creates pass,
 * updates submission, worlds first, player stats, and rating.
 * Throws on validation or processing errors.
 */
async function approvePassSubmission(
  submissionId: number,
  transaction: Transaction,
): Promise<ApprovePassSubmissionResult> {

  const submission = await PassSubmission.findByPk(submissionId, 
    { include: [
      { model: Level, as: 'level', 
        include: [ 
          { model: Difficulty, as: 'difficulty' } 
        ] 
      },
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
  const accuracy = calcAcc(judgementData as IPassSubmissionJudgements);
  const scoreV2 = getScoreV2(
    {
      speed,
      judgements: judgementData as IPassSubmissionJudgements,
      isNoHoldTap: flags.isNoHoldTap || false,
    },
    { baseScore: level.baseScore, ppBaseScore: level.ppBaseScore, difficulty },
  );

  if (!isValidNumber(accuracy)) {
    throw new Error('Failed to calculate valid accuracy from judgements');
  }
  if (!isValidNumber(scoreV2)) {
    throw new Error('Failed to calculate valid score - check level base score and difficulty');
  }

  const passData = {
    levelId: submission.levelId,
    playerId: submission.assignedPlayerId,
    speed,
    vidTitle: submission.title || '',
    videoLink: submission.videoLink,
    vidUploadTime: submission.rawTime || new Date(),
    is12K: flags.is12K || false,
    is16K: flags.is16K || false,
    isNoHoldTap: flags.isNoHoldTap || false,
    feelingRating: submission.feelingDifficulty || null,
    accuracy,
    scoreV2,
    isAnnounced: false,
    isDeleted: false,
  };

  const pass = await Pass.create(passData, { transaction });

  const now = new Date();
  const judgementRecord = await Judgement.create(
    { id: pass.id, ...judgementData, createdAt: now, updatedAt: now },
    { transaction },
  );
  if (!judgementRecord) {
    throw new Error(`Failed to create judgement record for pass #${pass.id}`);
  }

  await submission.update({ status: 'approved', passId: pass.id }, { transaction });
  await updateWorldsFirstStatus(submission.levelId, transaction);

  const newPass = await Pass.findByPk(pass.id, {
    include: [
      { model: Player, as: 'player' },
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
      { model: Judgement, as: 'judgements' },
    ],
    transaction,
  });

  if (!newPass) throw new Error(`Failed to fetch created pass #${pass.id}`);

  let playerStats: ApprovePassSubmissionResult['playerStats'] = null;
  try {
    await elasticsearchService.reindexPlayers([submission.assignedPlayerId]);
    playerStats = (await playerStatsService.getPlayerStats(submission.assignedPlayerId))[0];
  } catch (statsError) {
    logger.warn('Failed to update player stats during approval', {
      submissionId: submission.id,
      playerId: submission.assignedPlayerId,
      error: statsError instanceof Error ? statsError.message : String(statsError),
    });
  }

  if (level.clears === 0 && difficulty.name.includes('Q') && speed === 1) {
    let reqFr = (submission.feelingDifficulty ?? '');
    if (difficulty.name.includes('UQ')) {
      reqFr = `vote (${submission.feelingDifficulty ?? ''})`;
    }
    await Rating.create(
      { levelId: submission.levelId, lowDiff: false, requesterFR: submission.feelingDifficulty?.substring(0, 60) || 'cleared' },
      { transaction },
    );
    await Level.update({ 
      toRate: true, 
      previousDiffId: level.diffId,
      previousBaseScore: level.baseScore || difficulty.baseScore || 0,
      rerateNum: reqFr.substring(0, 60) || '', 
      rerateReason: 'cleared'}, 
      { where: { id: submission.levelId }, 
      transaction });
  }

  return { pass, newPass: newPass as Pass, playerStats };
}

interface CreditStats {
  charterCount: number;
  vfxerCount: number;
  totalCredits: number;
}

interface CreatorCredit {
  role: string;
  levelId: number;
  creatorId: number;
  id: number;
}

interface CreatorWithCredits {
  credits?: CreatorCredit[];
  id: number;
  name: string;
}

interface CreatorRequest {
  creator?: CreatorWithCredits;
}

// Get all level submissions
router.get(
  '/levels',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'getAdminLevelSubmissions',
    summary: 'List level submissions',
    description: 'List all level submissions. Super admin.',
    tags: ['Admin', 'Submissions'],
    security: ['bearerAuth'],
    responses: { 200: { description: 'Level submissions' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
    try {
      const levelSubmissions = await LevelSubmission.findAll();
      return res.json(levelSubmissions);
    } catch (error) {
      logger.error('Error fetching level submissions:', error);
      return res.status(500).json({error: 'Failed to fetch level submissions'});
    }
  }
);

// Get pending level submissions
router.get(
  '/levels/pending',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'getAdminLevelSubmissionsPending',
    summary: 'List pending level submissions',
    description: 'List pending level submissions with full includes. Super admin.',
    tags: ['Admin', 'Submissions'],
    security: ['bearerAuth'],
    responses: { 200: { description: 'Pending level submissions' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
  try {
    const pendingLevelSubmissions = await LevelSubmission.findAll({
      where: { status: 'pending' },
      include: [
        {
          model: LevelSubmissionCreatorRequest,
          as: 'creatorRequests',
          include: [
            {
              model: Creator,
              as: 'creator',
              include: [
                {
                  model: LevelCredit,
                  as: 'credits',
                  required: false
                }
              ]
            }
          ]
        },
        {
          model: LevelSubmissionTeamRequest,
          as: 'teamRequestData',
          include: [
            {
              model: Team,
              as: 'team',
              include: [
                {
                  model: Level,
                  as: 'levels',
                  required: false
                },
                {
                  model: TeamAlias,
                  as: 'teamAliases',
                  required: false
                }
              ]
            }
          ]
        },
        {
          model: LevelSubmissionSongRequest,
          as: 'songRequest',
          include: [
            {
              model: Song,
              as: 'song'
            }
          ]
        },
        {
          model: LevelSubmissionArtistRequest,
          as: 'artistRequests',
          include: [
            {
              model: Artist,
              as: 'artist'
            }
          ]
        },
        {
          model: LevelSubmissionEvidence,
          as: 'evidence'
        },
        {
          model: Song,
          as: 'songObject',
          include: [
            {
              model: SongCredit,
              as: 'credits',
              include: [
                {
                  model: Artist,
                  as: 'artist',
                  attributes: ['id', 'name']
                }
              ],
              required: false
            }
          ]
        },
        {
          model: Artist,
          as: 'artistObject'
        },
        {
          model: User,
          as: 'levelSubmitter',
          required: false,
          attributes: ['id', 'username', 'playerId', 'creatorId'],
          include: [
            {
              model: Creator,
              as: 'creator',
              required: false,
              attributes: ['id', 'name', 'verificationStatus']
            }
          ]
        }
      ]
    });

    const submissionsWithStats = pendingLevelSubmissions.map(submission => {
      const submissionData = submission.toJSON();

      // Process creator requests
      submissionData.creatorRequests = submissionData.creatorRequests?.map((request: CreatorRequest) => {
        if (request.creator?.credits) {
          const credits = request.creator.credits;
          const creditStats: CreditStats = {
            charterCount: credits.filter((credit: CreatorCredit) => credit.role === 'charter').length,
            vfxerCount: credits.filter((credit: CreatorCredit) => credit.role === 'vfxer').length,
            totalCredits: credits.length
          };
          (request.creator as any).credits = creditStats;
        }
        return request;
      });

      // Process team request data
      if (submissionData.teamRequestData?.team) {
        const team = submissionData.teamRequestData.team;
        team.credits = {
          totalLevels: team.levels?.length || 0,
          memberCount: team.members?.length || 0
        };
        // Clean up levels array to avoid sending too much data
        delete team.levels;
      }

      return submissionData;
    });

    return res.json(submissionsWithStats);
  } catch (error) {
    logger.error('Error fetching pending level submissions:', error);
    return res.status(500).json({ error: 'Failed to fetch pending level submissions' });
  }
  }
);

// Get all pass submissions
router.get(
  '/passes',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'getAdminPassSubmissions',
    summary: 'List pass submissions',
    description: 'List all pass submissions. Super admin.',
    tags: ['Admin', 'Submissions'],
    security: ['bearerAuth'],
    responses: { 200: { description: 'Pass submissions' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
    try {
      const passSubmissions = await PassSubmission.findAll({
        include: [
          {
            model: PassSubmissionJudgements,
            as: 'judgements',
          },
          {
            model: PassSubmissionFlags,
            as: 'flags',
          },
        ],
      });
      return res.json(passSubmissions);
    } catch (error) {
      logger.error('Error fetching pass submissions:', error);
      return res.status(500).json({error: 'Failed to fetch pass submissions'});
    }
  }
);

// Get pending pass submissions
router.get(
  '/passes/pending',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'getAdminPassSubmissionsPending',
    summary: 'List pending pass submissions',
    description: 'List pending pass submissions with includes. Super admin.',
    tags: ['Admin', 'Submissions'],
    security: ['bearerAuth'],
    responses: { 200: { description: 'Pending pass submissions' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
    try {
      const submissions = await PassSubmission.findAll({
        where: {status: 'pending'},
        include: [
          {
            model: Player,
            as: 'assignedPlayer',
          },
          {
            model: PassSubmissionJudgements,
            as: 'judgements',
          },
          {
            model: PassSubmissionFlags,
            as: 'flags',
          },
          {
            model: Level,
            as: 'level',
            include: [
              {
                model: Difficulty,
                as: 'difficulty',
              },
            ],
          },
          {
            model: User,
            as: 'passSubmitter',
            required: false,
            attributes: ['id', 'username', 'playerId']
          }
        ],
        order: [['createdAt', 'DESC']],
      });
      return res.json(submissions);
    } catch (error) {
      logger.error('Error fetching pending pass submissions:', error);
      return res
        .status(500)
        .json({error: 'Failed to fetch pending pass submissions'});
    }
  }
);

// Handle level submission actions (approve/reject)
router.put(
  '/levels/:id/approve',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'putAdminLevelSubmissionApprove',
    summary: 'Approve level submission',
    description: 'Approve pending level submission; creates level and rating. Super admin.',
    tags: ['Admin', 'Submissions'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    responses: { 200: { description: 'Submission approved' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
    let transaction: any;
    let rollbackReason = '';
    try {
      transaction = await sequelize.transaction();
      const {id} = req.params;
        const submissionObj = await LevelSubmission.findOne({
          where: {[Op.and]: [{id}, {status: 'pending'}]},
          include: [
            {
              model: LevelSubmissionCreatorRequest,
              as: 'creatorRequests'
            },
            {
              model: LevelSubmissionTeamRequest,
              as: 'teamRequestData'
            },
            {
              model: LevelSubmissionSongRequest,
              as: 'songRequest'
            },
            {
              model: LevelSubmissionArtistRequest,
              as: 'artistRequests'
            },
            {
              model: LevelSubmissionEvidence,
              as: 'evidence'
            },
            {
              model: Song,
              as: 'songObject',
              include: [
                {
                  model: SongCredit,
                  as: 'credits',
                  include: [
                    {
                      model: Artist,
                      as: 'artist',
                      attributes: ['id', 'name']
                    }
                  ],
                  required: false
                }
              ]
            },
            {
              model: Artist,
              as: 'artistObject'
            }
          ],
          transaction,
        });

        if (!submissionObj) {
          rollbackReason = 'Submission not found';
          await safeTransactionRollback(transaction, logger);
          return res.status(404).json({error: 'Submission not found'});
        }

        // Check if all creator requests are either assigned or marked as new
        const hasUnhandledCreators = submissionObj.creatorRequests?.some(
          (request) => !request.creatorId && !request.isNewRequest
        );

        if (hasUnhandledCreators) {
          rollbackReason = 'All creators must be either assigned to existing creators or marked as new creators';
          await safeTransactionRollback(transaction, logger);
          return res.status(400).json({
            error: 'All creators must be either assigned to existing creators or marked as new creators'
          });
        }

        // Check if team request is properly handled
        if (submissionObj.teamRequestData && !submissionObj.teamRequestData.teamId && !submissionObj.teamRequestData.isNewRequest) {
          rollbackReason = 'Team must be either assigned to an existing team or marked as a new team';
          await safeTransactionRollback(transaction, logger);
          return res.status(400).json({
            error: 'Team must be either assigned to an existing team or marked as a new team'
          });
        }

        const submission = submissionObj.dataValues;

        // Get first charter and vfxer from creator requests
        const firstCharter = submission.creatorRequests?.find((r: LevelSubmissionCreatorRequest) => r.role === 'charter');
        const firstVfxer = submission.creatorRequests?.find((r: LevelSubmissionCreatorRequest) => r.role === 'vfxer');

        // Handle team request
        let teamId = null;
        let team = null;
        // Only process team if there is a team request
        if (submission.teamRequestData) {
          if (submission.teamRequestData.teamId) {
            // Use existing team
            team = await Team.findByPk(submission.teamRequestData.teamId, { transaction });
            if (!team) {
              rollbackReason = 'Referenced team not found';
              await safeTransactionRollback(transaction, logger);
              return res.status(404).json({ error: 'Referenced team not found' });
            }
            teamId = team.id;
          } else if (submission.teamRequestData.isNewRequest) {
            // Create new team
            [team] = await Team.findOrCreate({
              where: { name: submission.teamRequestData.teamName.trim() },
              transaction,
            });
            teamId = team.id;
          }
        }

        // Check if all existing creators are verified
        const existingCreatorIds = submission.creatorRequests
          ?.filter((r: LevelSubmissionCreatorRequest) => r.creatorId)
          .map((r: LevelSubmissionCreatorRequest) => r.creatorId);

        const existingCreators = await Creator.findAll({
          where: {
            id: existingCreatorIds
          },
          transaction
        });

        // Validate song request before processing
        if (submission.songRequest) {
          const hasSongId = !!submission.songRequest.songId;
          const hasNewSongRequest = submission.songRequest.isNewRequest && !!submission.songRequest.songName;

          if (!hasSongId && !hasNewSongRequest) {
            rollbackReason = 'Song request exists but is incomplete: must have either songId or (isNewRequest=true and songName)';
            await safeTransactionRollback(transaction, logger);
            return res.status(400).json({
              error: 'Song request is incomplete. Please either assign an existing song or mark it as a new song request with a name.'
            });
          }
        }

        // Handle song request
        let finalSongId: number | null = null;
        if (submission.songRequest) {
          if (submission.songRequest.songId) {
            // Use existing song
            finalSongId = submission.songRequest.songId;
          } else if (submission.songRequest.isNewRequest && submission.songRequest.songName) {
            // Create new song with verificationState from request
            const verificationState = submission.songRequest.verificationState || 'pending';
            const [song] = await Song.findOrCreate({
              where: { name: submission.songRequest.songName.trim() },
              defaults: {
                name: submission.songRequest.songName.trim(),
                verificationState: verificationState
              },
              transaction
            });
            finalSongId = song.id;
          }
        } else if (submission.songId) {
          // Use songId directly from submission
          finalSongId = submission.songId;
        }

        // Validate artist requests before processing (only if not inheriting from song credits)
        if (!(finalSongId && submission.songObject?.credits)) {
          if (submission.artistRequests && submission.artistRequests.length > 0) {
            for (const artistRequest of submission.artistRequests) {
              const hasArtistId = !!artistRequest.artistId;
              const hasNewArtistRequest = artistRequest.isNewRequest && !!artistRequest.artistName;

              if (!hasArtistId && !hasNewArtistRequest) {
                rollbackReason = `Artist request is incomplete: must have either artistId or (isNewRequest=true and artistName). Artist: ${artistRequest.artistName || 'unknown'}`;
                await safeTransactionRollback(transaction, logger);
                return res.status(400).json({
                  error: 'Artist request is incomplete. Please either assign an existing artist or mark it as a new artist request with a name.'
                });
              }
            }
          }
        }

        // Handle artist requests (multiple artists supported)
        const finalArtistIds: number[] = [];
        let finalArtistString = '';

        // If we have an existing song, inherit artists from song credits and discard submission artist requests
        if (finalSongId && submission.songObject?.credits) {
          // Extract artist IDs and names from song credits
          const songCredits = submission.songObject.credits || [];
          for (const credit of songCredits) {
            if (credit.artist?.id) {
              finalArtistIds.push(credit.artist.id);
            }
          }

          // Format artist string from song credits (join with ' & ')
          const artistNames = songCredits
            .map((credit: any) => credit.artist?.name)
            .filter((name: string | undefined): name is string => !!name);
          finalArtistString = artistNames.join(' & ');
        } else {
          // For new songs, process artist requests as before
          if (submission.artistRequests && submission.artistRequests.length > 0) {
            // Process multiple artist requests
            for (const artistRequest of submission.artistRequests) {
              if (artistRequest.artistId) {
                // Use existing artist
                finalArtistIds.push(artistRequest.artistId);
              } else if (artistRequest.isNewRequest && artistRequest.artistName) {
                // Create new artist with verification state from request
                const verificationState = artistRequest.verificationState || 'unverified';
                const artist = await artistService.findOrCreateArtist(
                  artistRequest.artistName.trim(),
                  undefined,
                  verificationState as Artist['verificationState']
                );
                finalArtistIds.push(artist.id);
              }
            }
          } else if (submission.artistId) {
            // Fallback: Use artistId directly from submission (backward compatibility)
            finalArtistIds.push(submission.artistId);
          }

          // Format artist string from artist requests (fallback to submission.artist if no requests)
          if (finalArtistIds.length > 0) {
            // Fetch artist names for formatting
            const artists = await Artist.findAll({
              where: { id: finalArtistIds },
              attributes: ['id', 'name'],
              transaction
            });
            const artistNames = artists.map(a => a.name);
            finalArtistString = artistNames.join(' & ');
          } else {
            finalArtistString = submission.artist || '';
          }
        }

        // Final validation: ensure we have required data
        if (submission.songRequest && !finalSongId) {
          rollbackReason = 'Song request was processed but no songId was resolved';
          await safeTransactionRollback(transaction, logger);
          return res.status(400).json({
            error: 'Failed to resolve song from song request. Please ensure the song request is properly configured.'
          });
        }

        // Validate artist data if we have artist requests but no final artists (and not inheriting from song)
        if (!(finalSongId && submission.songObject?.credits)) {
          if (submission.artistRequests && submission.artistRequests.length > 0 && finalArtistIds.length === 0) {
            rollbackReason = 'Artist requests were processed but no artistIds were resolved';
            await safeTransactionRollback(transaction, logger);
            return res.status(400).json({
              error: 'Failed to resolve artists from artist requests. Please ensure all artist requests are properly configured.'
            });
          }
        }

        // Create song credit relationships for all artists (only needed for new songs)
        // For existing songs, credits already exist, so skip this
        if (finalSongId && finalArtistIds.length > 0 && !submission.songObject?.credits) {
          for (const artistId of finalArtistIds) {
            // Check if credit already exists
            const existingCredit = await SongCredit.findOne({
              where: {
                songId: finalSongId,
                artistId: artistId
              },
              transaction
            });

            if (!existingCredit) {
              await SongCredit.create({
                songId: finalSongId,
                artistId: artistId,
                role: null // Primary artist relationship
              }, { transaction });
            }
          }
        }


        const newLevel = await Level.create(
          {
            song: submission.song + (submission.suffix ? " " + submission.suffix : ''),
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
            rerateReason: '',
            rerateNum: '',
            previousDiffId: 0,
            isAnnounced: false,
            isHidden: false,
            teamId: teamId,
            isExternallyAvailable: false,
          },
          {transaction},
        );

        const lowRatingRegex = /^[pP]\d|^[1-9]$|^1[0-9]\+?$|^([1-9]|1[0-9]\+?)(~|-)([1-9]|1[0-9]\+?)$/;
        // Create rating since toRate is true
        await Rating.create(
          {
            levelId: newLevel.id,
            lowDiff: lowRatingRegex.test(submission.diff),
            requesterFR: submission.diff,
            averageDifficultyId: null,
          },
          {transaction},
        );

        // Create level credits for each creator request
        for (const request of submission.creatorRequests || []) {
          if (request.creatorId) {
            // Submitting user is the owner
            const isOwner = request.id === req.user?.creatorId;
            // For existing creators
            // Check if credit already exists
            const existingCredit = await LevelCredit.findOne({
              where: {
                levelId: newLevel.id,
                creatorId: request.creatorId,
                role: request.role
              },
              transaction
            });

            if (!existingCredit) {
              await LevelCredit.create({
                levelId: newLevel.id,
                creatorId: request.creatorId,
                role: request.role,
                isOwner: isOwner,
              }, {
                transaction
              });
            }
          }
          else if (request.isNewRequest) {
            // For new creators
            const [creator] = await Creator.findOrCreate({
              where: { name: request.creatorName.trim() },
              defaults: {
                verificationStatus: 'pending'
              },
              transaction
            });

            // Check if credit already exists
            const existingCredit = await LevelCredit.findOne({
              where: {
                levelId: newLevel.id,
                creatorId: creator.id,
                role: request.role
              },
              transaction
            });

            if (!existingCredit) {
              await LevelCredit.create({
                levelId: newLevel.id,
                creatorId: creator.id,
                role: request.role,
              }, {
                transaction
              });
            }
          }
        }

        await LevelSubmission.update(
          {status: 'approved', toRate: true},
          {
            where: {id},
            transaction,
          },
        );


        // Broadcast updates
        sseManager.broadcast({type: 'submissionUpdate'});
        sseManager.broadcast({type: 'levelUpdate'});
        sseManager.broadcast({
          type: 'submissionUpdate',
          data: {
            action: 'approve',
            submissionId: id,
            submissionType: 'level',
          },
        });

        // Move evidence from submission to song/artist if approved
        if (submission.evidence && submission.evidence.length > 0) {
          for (const evidence of submission.evidence) {
            if (evidence.type === 'song' && finalSongId) {
              await evidenceService.addEvidenceToSong(
                finalSongId,
                evidence.link,
                transaction
              );
            } else if (evidence.type === 'artist' && finalArtistIds.length > 0) {
              // Add evidence to all artists in the request
              for (const artistId of finalArtistIds) {
                await evidenceService.addEvidenceToArtist(
                  artistId,
                  evidence.link,
                  transaction
                );
              }
            }
          }
        }

        await transaction.commit();

        await applyLevelChartStatsFromCdn(newLevel.id);

        // Auto-assign tags based on level analysis
        try {
          const tagResult = await tagAssignmentService.assignAutoTags(newLevel.id);
          if (tagResult.assignedTags.length > 0) {
            logger.debug('Auto tags assigned to new level', {
              levelId: newLevel.id,
              assignedTags: tagResult.assignedTags,
            });
            // Reindex level to include new tags
            await elasticsearchService.reindexLevels([newLevel.id]);
          }
        } catch (tagError) {
          // Log error but don't fail the approval
          logger.warn('Failed to assign auto tags to new level:', {
            levelId: newLevel.id,
            error: tagError instanceof Error ? tagError.message : String(tagError),
          });
        }

        return res.json({
          message: 'Submission approved, level and rating created successfully',
        });
    } catch (error) {
      await safeTransactionRollback(transaction, logger);
      logger.error('Error approving level submission:', {error, submissionId: req.params.id, rollbackReason});
      return res
        .status(500)
        .json({error: 'Failed to process level submission'});
    }
  },
);


router.put(
  '/levels/:id/decline',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'putAdminLevelSubmissionDecline',
    summary: 'Decline level submission',
    description: 'Decline pending level submission. Super admin.',
    tags: ['Admin', 'Submissions'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    responses: { 200: { description: 'Submission declined' }, ...standardErrorResponses404500 },
  }),
  async (req: Request, res: Response) => {
    let transaction: any;
    let rollbackReason = '';
    try {
      transaction = await sequelize.transaction();
      const {id} = req.params;

      // Get the submission to check if it has a level zip and evidence
      const submission = await LevelSubmission.findByPk(id, {
        include: [
          {
            model: LevelSubmissionEvidence,
            as: 'evidence'
          }
        ],
        transaction
      });
      if (!submission) {
        rollbackReason = 'Submission not found';
        await safeTransactionRollback(transaction, logger);
        return res.status(404).json({error: 'Submission not found'});
      }

      // Check if the directDL is a local CDN URL
      if (submission.directDL && submission.directDL.includes(CDN_CONFIG.baseUrl)) {
        // Extract fileId from URL (could be /api/{fileId} or /cdn/levels/{fileId})
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

      // Delete all evidence images from CDN
      const submissionWithEvidence = submission as LevelSubmission & { evidence?: LevelSubmissionEvidence[] };
      if (submissionWithEvidence.evidence && submissionWithEvidence.evidence.length > 0) {
        await evidenceService.deleteAllEvidenceForSubmission(parseInt(id));
      }

      await LevelSubmission.update(
        {status: 'declined'},
        {
          where: {id},
          transaction,
        },
      );



      // Broadcast updates
      sseManager.broadcast({type: 'submissionUpdate'});
      sseManager.broadcast({
        type: 'submissionUpdate',
        data: {
          action: 'decline',
          submissionId: id,
          submissionType: 'level',
        },
      });

      await transaction.commit();

      return res.json({message: 'Submission declined successfully'});
    } catch (error) {
      await safeTransactionRollback(transaction, logger);
      logger.error('Error declining level submission:', {error, submissionId: req.params.id, rollbackReason});
      return res
        .status(500)
        .json({error: 'Failed to process level submission'});
    }
  },
);


// Split pass submission actions into specific endpoints
router.put(
  '/passes/:id/approve',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'putAdminPassSubmissionApprove',
    summary: 'Approve pass submission',
    description: 'Approve pending pass submission; creates pass. Super admin.',
    tags: ['Admin', 'Submissions'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    responses: { 200: { description: 'Pass submission approved' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
    let transaction: any;
    const submissionId = req.params.id;

    try {
      transaction = await sequelize.transaction();
      const submission = await PassSubmission.findOne({
        where: {[Op.and]: [{id: parseInt(submissionId)}, {status: 'pending'}]},
        include: PASS_SUBMISSION_APPROVE_INCLUDES,
        lock: true,
        transaction,
      });

      if (!submission) {
        await safeTransactionRollback(transaction, logger);
        return res.status(404).json({error: 'Submission not found or already processed'});
      }

      const { pass, newPass, playerStats } = await approvePassSubmission(submission.id, transaction);

      await transaction.commit();

      await elasticsearchService.indexPass(newPass);
      await elasticsearchService.indexLevel(newPass.level!);

      sseManager.broadcast({
        type: 'submissionUpdate',
        data: { action: 'create', submissionId: submission.id, submissionType: 'pass' },
      });

      if (submission.assignedPlayerId && playerStats) {
        sseManager.broadcast({
          type: 'passUpdate',
          data: {
            playerId: submission.assignedPlayerId,
            passedLevelId: submission.levelId,
            newScore: playerStats?.rankedScore || 0,
            action: 'create',
          },
        });
      }

      if (submission.assignedPlayerId) {
        roleSyncService.getDiscordIdForPlayer(submission.assignedPlayerId)
          .then(discordId => {
            if (discordId) {
              roleSyncService.notifyBotOfRoleSyncByDiscordIds([discordId]).catch(() => {});
            }
          })
          .catch(err => {
            logger.debug(`[submissions] Failed to notify bot of role sync: ${err.message}`);
          });
      }

      return res.json({ message: 'Pass submission approved successfully', pass });
    } catch (error) {
      await safeTransactionRollback(transaction, logger);
      const errorDetails = extractErrorDetails(error);
      logger.error('Error processing pass submission:', {
        submissionId,
        errorMessage: errorDetails.message,
        sqlQuery: errorDetails.sql,
        originalError: errorDetails.original,
        fields: errorDetails.fields,
      });
      const validationPhrases = [
        'Pass already exists', 'Level data not found', 'difficulty not found',
        'No player assigned', 'does not exist', 'Judgements data not found',
        'Flags data not found', 'Invalid level', 'Failed to calculate',
      ];
      const isValidation = validationPhrases.some(p => errorDetails.message?.includes(p));
      return res.status(isValidation ? 400 : 500).json({
        error: 'Failed to process pass submission',
        details: errorDetails.message,
      });
    }
  }
);

router.put(
  '/passes/:id/decline',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'putAdminPassSubmissionDecline',
    summary: 'Decline pass submission',
    description: 'Decline pending pass submission. Super admin.',
    tags: ['Admin', 'Submissions'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    responses: { 200: { description: 'Pass submission declined' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
    let transaction: any;
    try {
      transaction = await sequelize.transaction();
      await PassSubmission.update(
        {status: 'declined'},
        {
          where: {id: parseInt(req.params.id)},
          transaction,
        }
      );

      // Broadcast updates
      sseManager.broadcast({type: 'submissionUpdate'});
      sseManager.broadcast({
        type: 'submissionUpdate',
        data: {
          action: 'decline',
          submissionId: req.params.id,
          submissionType: 'pass',
        },
      });

      await transaction.commit();

      return res.json({message: 'Pass submission rejected successfully'});
    } catch (error) {
      await safeTransactionRollback(transaction, logger);
      const errorDetails = extractErrorDetails(error);
      logger.error('Error declining pass submission:', {
        submissionId: req.params.id,
        errorMessage: errorDetails.message,
        sqlQuery: errorDetails.sql,
        originalError: errorDetails.original,
      });
      return res.status(500).json({
        error: 'Failed to decline pass submission',
        details: errorDetails.message,
      });
    }
  }
);

router.put(
  '/passes/:id([0-9]{1,20})',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'putAdminPassSubmissionPartial',
    summary: 'Partially update pending pass submission',
    description:
      'Update levelId, speed, judgements, and/or flags on a pending pass submission. Omitted nested keys are unchanged. Super admin.',
    tags: ['Admin', 'Submissions'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    requestBody: {
      description:
        'Partial fields: levelId (number), speed (number), judgements (partial object), flags (partial object). At least one required.',
      schema: {
        type: 'object',
        properties: {
          levelId: { type: 'number' },
          speed: { type: 'number' },
          judgements: {
            type: 'object',
            properties: {
              earlyDouble: { type: 'integer' },
              earlySingle: { type: 'integer' },
              ePerfect: { type: 'integer' },
              perfect: { type: 'integer' },
              lPerfect: { type: 'integer' },
              lateSingle: { type: 'integer' },
              lateDouble: { type: 'integer' },
            },
          },
          flags: {
            type: 'object',
            properties: {
              is12K: { type: 'boolean' },
              isNoHoldTap: { type: 'boolean' },
              is16K: { type: 'boolean' },
            },
          },
        },
      },
      required: false,
    },
    responses: { 200: { description: 'Submission updated' }, ...standardErrorResponses404500 },
  }),
  async (req: Request, res: Response) => {
    let transaction: any;
    try {
      transaction = await sequelize.transaction();
      const submissionId = parseInt(req.params.id);
      if (Number.isNaN(submissionId) || submissionId <= 0) {
        await safeTransactionRollback(transaction, logger);
        return res.status(400).json({ error: 'Invalid submission id' });
      }

      const body = req.body as {
        levelId?: unknown;
        speed?: unknown;
        judgements?: Record<string, unknown>;
        flags?: Record<string, unknown>;
      };

      const hasLevelId = Object.prototype.hasOwnProperty.call(body, 'levelId');
      const hasSpeed = Object.prototype.hasOwnProperty.call(body, 'speed');
      const hasJudgements = Object.prototype.hasOwnProperty.call(body, 'judgements');
      const hasFlags = Object.prototype.hasOwnProperty.call(body, 'flags');

      if (!hasLevelId && !hasSpeed && !hasJudgements && !hasFlags) {
        await safeTransactionRollback(transaction, logger);
        return res.status(400).json({
          error: 'Request body must include at least one of: levelId, speed, judgements, flags',
        });
      }

      const submission = await PassSubmission.findByPk(submissionId, {
        include: [...PASS_SUBMISSION_ADMIN_PUT_INCLUDES],
        transaction,
      });

      if (!submission) {
        await safeTransactionRollback(transaction, logger);
        return res.status(404).json({ error: 'Submission not found' });
      }

      if (submission.status !== 'pending') {
        await safeTransactionRollback(transaction, logger);
        return res.status(400).json({ error: 'Only pending pass submissions can be edited' });
      }

      if (!submission.judgements || !submission.flags) {
        await safeTransactionRollback(transaction, logger);
        return res.status(500).json({ error: 'Submission judgements or flags missing' });
      }

      let touchedScoreInputs = false;

      if (hasLevelId) {
        const levelId = typeof body.levelId === 'number' ? body.levelId : parseInt(String(body.levelId), 10);
        if (Number.isNaN(levelId) || levelId <= 0) {
          await safeTransactionRollback(transaction, logger);
          return res.status(400).json({ error: 'Invalid levelId' });
        }
        const levelExists = await Level.findByPk(levelId, { transaction });
        if (!levelExists) {
          await safeTransactionRollback(transaction, logger);
          return res.status(404).json({ error: 'Level not found' });
        }
        await submission.update({ levelId }, { transaction });
        touchedScoreInputs = true;
      }

      if (hasSpeed) {
        const speed = validateSpeedFloatInput(body.speed);
        await submission.update({ speed }, { transaction });
        touchedScoreInputs = true;
      }

      if (hasJudgements && body.judgements && typeof body.judgements === 'object') {
        const j = body.judgements;
        const patch: Partial<Record<(typeof JUDGEMENT_FIELD_KEYS)[number], number>> = {};
        for (const key of JUDGEMENT_FIELD_KEYS) {
          if (Object.prototype.hasOwnProperty.call(j, key)) {
            patch[key] = sanitizeJudgementInt(j[key]);
          }
        }
        if (Object.keys(patch).length > 0) {
          await submission.judgements.update(patch, { transaction });
          touchedScoreInputs = true;
        }
      }

      if (hasFlags && body.flags && typeof body.flags === 'object') {
        const f = body.flags;
        const patch: Partial<{ is12K: boolean; isNoHoldTap: boolean; is16K: boolean }> = {};
        if (Object.prototype.hasOwnProperty.call(f, 'is12K')) {
          patch.is12K = f.is12K === true || f.is12K === 'true';
        }
        if (Object.prototype.hasOwnProperty.call(f, 'isNoHoldTap')) {
          patch.isNoHoldTap = f.isNoHoldTap === true || f.isNoHoldTap === 'true';
        }
        if (Object.prototype.hasOwnProperty.call(f, 'is16K')) {
          patch.is16K = f.is16K === true || f.is16K === 'true';
        }
        if (Object.keys(patch).length > 0) {
          await submission.flags.update(patch, { transaction });
          touchedScoreInputs = true;
        }
      }

      if (touchedScoreInputs) {
        await submission.reload({
          include: [...PASS_SUBMISSION_ADMIN_PUT_INCLUDES],
          transaction,
        });

        const level = submission.level;
        const judgements = submission.judgements;
        const flags = submission.flags;

        if (!level?.difficulty || !judgements || !flags) {
          await safeTransactionRollback(transaction, logger);
          return res.status(400).json({
            error: 'Cannot recalculate score: level difficulty or judgements/flags missing',
          });
        }

        const judgementData = {
          earlyDouble: judgements.earlyDouble || 0,
          earlySingle: judgements.earlySingle || 0,
          ePerfect: judgements.ePerfect || 0,
          perfect: judgements.perfect || 0,
          lPerfect: judgements.lPerfect || 0,
          lateSingle: judgements.lateSingle || 0,
          lateDouble: judgements.lateDouble || 0,
        };

        const speed = submission.speed ?? 1;
        const accuracy = calcAcc(judgementData as IPassSubmissionJudgements);
        const scoreV2 = getScoreV2(
          {
            speed,
            judgements: judgementData as IPassSubmissionJudgements,
            isNoHoldTap: flags.isNoHoldTap || false,
          },
          {
            baseScore: level.baseScore,
            ppBaseScore: level.ppBaseScore,
            difficulty: level.difficulty,
          },
        );

        if (!isValidNumber(accuracy)) {
          await safeTransactionRollback(transaction, logger);
          return res.status(400).json({ error: 'Invalid judgements — could not calculate accuracy' });
        }
        if (!isValidNumber(scoreV2)) {
          await safeTransactionRollback(transaction, logger);
          return res.status(400).json({ error: 'Invalid score — check level and judgements' });
        }

        await submission.update({ scoreV2 }, { transaction });
      }

      await submission.reload({
        include: [...PASS_SUBMISSION_ADMIN_PUT_INCLUDES],
        transaction,
      });

      sseManager.broadcast({
        type: 'submissionUpdate',
        data: {
          action: 'update',
          submissionId: String(submissionId),
          submissionType: 'pass',
        },
      });

      await transaction.commit();

      return res.json({
        message: 'Pass submission updated successfully',
        submission,
      });
    } catch (error) {
      await safeTransactionRollback(transaction, logger);
      const errorDetails = extractErrorDetails(error);
      logger.error('Error updating pass submission:', {
        submissionId: req.params.id,
        errorMessage: errorDetails.message,
        sqlQuery: errorDetails.sql,
        originalError: errorDetails.original,
      });
      return res.status(500).json({
        error: 'Failed to update pass submission',
        details: errorDetails.message,
      });
    }
  },
);

router.put(
  '/passes/:id/assign-player',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'putAdminPassSubmissionAssignPlayer',
    summary: 'Assign player to pass submission',
    description: 'Assign a player to a pending pass submission. Body: playerId. Super admin.',
    tags: ['Admin', 'Submissions'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    requestBody: { description: 'playerId', schema: { type: 'object', properties: { playerId: { type: 'number' } }, required: ['playerId'] }, required: true },
    responses: { 200: { description: 'Player assigned' }, ...standardErrorResponses404500 },
  }),
  async (req: Request, res: Response) => {
    let transaction: any;
    try {
      transaction = await sequelize.transaction();
      const {playerId} = req.body;
      const submission = await PassSubmission.findByPk(parseInt(req.params.id), {
        include: [
          {
            model: Player,
            as: 'assignedPlayer',
          },
          {
            model: Level,
            as: 'level',
            include: [
              {
                model: Difficulty,
                as: 'difficulty',
              },
              {
                model: LevelCredit,
                as: 'levelCredits',
                include: [{
                  model: Creator,
                  as: 'creator',
                }],
              },
            ],
          },
          {
            model: PassSubmissionJudgements,
            as: 'judgements',
          },
          {
            model: PassSubmissionFlags,
            as: 'flags',
          },
        ],
        transaction,
      });

      if (!submission) {
        await safeTransactionRollback(transaction, logger);
        return res.status(404).json({error: 'Submission not found'});
      }

      await submission.update({assignedPlayerId: playerId}, {transaction});

      // Reload the submission to get the fresh player data
      await submission.reload({
        include: [
          {
            model: Player,
            as: 'assignedPlayer',
          },
          {
            model: Level,
            as: 'level',
            include: [
              {
                model: Difficulty,
                as: 'difficulty',
              },
              {
                model: LevelCredit,
                as: 'levelCredits',
                include: [{
                  model: Creator,
                  as: 'creator',
                }],
              },
            ],
          },
          {
            model: PassSubmissionJudgements,
            as: 'judgements',
          },
          {
            model: PassSubmissionFlags,
            as: 'flags',
          },
        ],
        transaction,
      });

      // Broadcast the update
      sseManager.broadcast({
        type: 'submissionUpdate',
        data: {
          action: 'assign-player',
          submissionId: req.params.id,
          submissionType: 'pass',
        },
      });

      await transaction.commit();

      return res.json({
        message: 'Player assigned successfully',
        submission,
      });
    } catch (error) {
      await safeTransactionRollback(transaction, logger);
      const errorDetails = extractErrorDetails(error);
      logger.error('Error assigning player:', {
        submissionId: req.params.id,
        playerId: req.body.playerId,
        errorMessage: errorDetails.message,
        sqlQuery: errorDetails.sql,
        originalError: errorDetails.original,
      });
      return res.status(500).json({
        error: 'Failed to assign player',
        details: errorDetails.message,
      });
    }
  }
);

// Auto-approve pass submissions
router.post(
  '/auto-approve/passes',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'postAdminAutoApprovePasses',
    summary: 'Auto-approve pass submissions',
    description: 'Approve all pending pass submissions that have an assigned player. Super admin.',
    tags: ['Admin', 'Submissions'],
    security: ['bearerAuth'],
    responses: { 200: { description: 'Results per submission' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
  try {
    const pendingSubmissions = await PassSubmission.findAll({
      where: { status: 'pending' },
      include: [
        {
          model: Level,
          as: 'level',
          include: [
            { model: Difficulty, as: 'difficulty' },
            { model: LevelCredit, as: 'levelCredits', include: [{ model: Creator, as: 'creator' }] },
          ],
          required: true,
        },
        { model: Player, as: 'assignedPlayer', required: true },
        { model: PassSubmissionFlags, as: 'flags', required: true },
        { model: PassSubmissionJudgements, as: 'judgements', required: true },
      ],
    });

    const results: Array<{
      id: number;
      success: boolean;
      error?: string;
      validationErrors?: string[];
    }> = [];

    for (const submission of pendingSubmissions) {
      let transaction: any;
      const validationErrors: string[] = [];

      try {
        transaction = await sequelize.transaction();
        const lockedSubmission = await PassSubmission.findOne({
          where: { id: submission.id, status: 'pending' },
          include: PASS_SUBMISSION_APPROVE_INCLUDES,
          lock: true,
          transaction,
        });

        if (!lockedSubmission) {
          validationErrors.push('Submission already processed or not found');
          throw new Error(`Validation failed: ${validationErrors.join(', ')}`);
        }

        const { newPass, playerStats } = await approvePassSubmission(lockedSubmission.id, transaction);

        await transaction.commit();

        await elasticsearchService.indexPass(newPass);
        await elasticsearchService.indexLevel(newPass.level!);

        if (lockedSubmission.assignedPlayerId && playerStats) {
          sseManager.broadcast({
            type: 'passUpdate',
            data: {
              playerId: lockedSubmission.assignedPlayerId,
              passedLevelId: lockedSubmission.levelId,
              newScore: playerStats?.rankedScore || 0,
              action: 'create',
            },
          });
        }

        if (lockedSubmission.assignedPlayerId) {
          roleSyncService.getDiscordIdForPlayer(lockedSubmission.assignedPlayerId)
            .then(discordId => {
              if (discordId) {
                roleSyncService.notifyBotOfRoleSyncByDiscordIds([discordId]).catch(() => {});
              }
            })
            .catch(err => {
              logger.debug(`[submissions] Failed to notify bot of role sync: ${err.message}`);
            });
        }

        results.push({ id: lockedSubmission.id, success: true });
      } catch (error) {
        await safeTransactionRollback(transaction, logger);
        const errorDetails = extractErrorDetails(error);
        if (!validationErrors.length) {
          validationErrors.push(errorDetails.message);
        }
        logger.error('Error auto-approving submission', {
          submissionId: submission.id,
          levelId: submission.levelId,
          playerId: submission.assignedPlayerId,
          errorMessage: errorDetails.message,
          sqlQuery: errorDetails.sql,
          originalError: errorDetails.original,
          validationErrors,
        });
        results.push({
          id: submission.id,
          success: false,
          error: errorDetails.message,
          validationErrors: validationErrors.length > 0 ? validationErrors : undefined,
        });
      }
    }

    sseManager.broadcast({ type: 'submissionUpdate' });
    sseManager.broadcast({
      type: 'submissionUpdate',
      data: {
        action: 'auto-approve',
        submissionType: 'pass',
        count: results.filter(r => r.success).length,
      },
    });

    getIO().emit('leaderboardUpdated');

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    return res.json({
      message: `Auto-approved ${successCount} submissions${failCount > 0 ? `, ${failCount} failed` : ''}`,
      results,
    });
  } catch (error) {
    const errorDetails = extractErrorDetails(error);
    logger.error('Error in auto-approve process:', {
      errorMessage: errorDetails.message,
      sqlQuery: errorDetails.sql,
      originalError: errorDetails.original,
    });
    return res.status(500).json({
      error: 'Failed to auto-approve submissions',
      details: errorDetails.message,
    });
  }
});


// Add endpoint to update profiles
router.put(
  '/levels/:id/profiles',
  ApiDoc({
    operationId: 'putAdminLevelSubmissionProfiles',
    summary: 'Update level submission profiles',
    description: 'Update creator requests and team request data for a submission. Body: creatorRequests?, teamRequestData?.',
    tags: ['Admin', 'Submissions'],
    params: { id: stringIdParamSpec },
    requestBody: { description: 'creatorRequests, teamRequestData', schema: { type: 'object' }, required: true },
    responses: { 200: { description: 'Updated submission' }, ...standardErrorResponses404500 },
  }),
  async (req: Request, res: Response) => {
  let transaction: any;

  try {
    transaction = await sequelize.transaction();
    const { id } = req.params;
    const { creatorRequests, teamRequestData } = req.body;

    // Simple updates without complex logic
    if (creatorRequests) {
      await Promise.all(creatorRequests.map(async (request: any) => {
        if (!request.id) return;

        await LevelSubmissionCreatorRequest.update({
          creatorId: request.creatorId,
          creatorName: request.creatorName,
          role: request.role,
          isNewRequest: false
        }, {
          where: {
            id: request.id,
            submissionId: id
          },
          transaction
        });
      }));
    }

    if (teamRequestData) {
      await LevelSubmissionTeamRequest.update({
        teamId: teamRequestData.teamId,
        teamName: teamRequestData.teamName,
        isNewRequest: false
      }, {
        where: { submissionId: id },
        transaction
      });
    }

    await transaction.commit();

    // Fetch fresh complete object with all associations AFTER committing the transaction
    const updatedSubmission = await LevelSubmission.findOne({
      where: { id },
      include: [
        {
          model: LevelSubmissionCreatorRequest,
          as: 'creatorRequests',
          include: [{
            model: Creator,
            as: 'creator',
            include: [
              {
                model: User,
                as: 'user',
                attributes: ['id', 'username']
              },
              {
                model: LevelCredit,
                as: 'credits',
                attributes: ['id', 'role']
              }
            ]
          }]
        },
        {
          model: LevelSubmissionTeamRequest,
          as: 'teamRequestData',
          include: [{
            model: Team,
            as: 'team',
            include: [
              {
                model: Creator,
                as: 'teamCreators',
                through: { attributes: [] },
                required: false
              }
            ]
          }]
        }
      ]
    });

    if (!updatedSubmission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    // Process the submission data to match the format used in pending submissions
    const submissionData = updatedSubmission.toJSON();

    // Process creator requests
    submissionData.creatorRequests = submissionData.creatorRequests?.map((request: any) => {
      if (request.creator?.credits) {
        const credits = request.creator.credits;
        const creditStats = {
          charterCount: credits.filter((credit: any) => credit.role === 'charter').length,
          vfxerCount: credits.filter((credit: any) => credit.role === 'vfxer').length,
          totalCredits: credits.length
        };
        request.creator.credits = creditStats;
      }
      return request;
    });

    // Process team request data
    if (submissionData.teamRequestData?.team) {
      const team = submissionData.teamRequestData.team;
      team.credits = {
        totalLevels: team.levels?.length || 0,
        memberCount: team.members?.length || 0
      };
      // Clean up levels array to avoid sending too much data
      delete team.levels;
    }

    return res.json(submissionData);

  } catch (error) {
    await safeTransactionRollback(transaction, logger);
    logger.error('Error updating submission profiles:', error);
    return res.status(500).json({ error: 'Failed to update submission profiles' });
  }
});

// Assign creator to submission
router.put(
  '/levels/:id/assign-creator',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'putAdminLevelSubmissionAssignCreator',
    summary: 'Assign creator to submission',
    description: 'Assign existing creator to a creator request. Body: creatorId, role, creditRequestId. Super admin.',
    tags: ['Admin', 'Submissions'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    requestBody: { description: 'creatorId, role, creditRequestId', schema: { type: 'object', properties: { creatorId: { type: 'number' }, role: { type: 'string' }, creditRequestId: { type: 'number' } }, required: ['creatorId', 'role', 'creditRequestId'] }, required: true },
    responses: { 200: { description: 'Creator assigned' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
    let transaction: any;

    try {
      transaction = await sequelize.transaction();
      const { id } = req.params;
      const { creatorId, role, creditRequestId } = req.body;

      if (!creatorId || !role || !creditRequestId) {
        await safeTransactionRollback(transaction, logger);
        return res.status(400).json({ error: 'Creator ID, role, and credit request ID are required' });
      }

      // Verify submission exists
      const submission = await LevelSubmission.findOne({
        where: { id },
        include: [
          {
            model: LevelSubmissionCreatorRequest,
            as: 'creatorRequests'
          }
        ],
        transaction
      });

      if (!submission) {
        await safeTransactionRollback(transaction, logger);
        return res.status(404).json({ error: 'Submission not found' });
      }

      // Verify creator exists and get their name
      const creator = await Creator.findByPk(creatorId, { transaction });
      if (!creator) {
        await safeTransactionRollback(transaction, logger);
        return res.status(404).json({ error: 'Creator not found' });
      }

      // Find and update the specific creator request
      const creatorRequest = await LevelSubmissionCreatorRequest.findOne({
        where: {
          id: creditRequestId,
          submissionId: parseInt(id),
          role
        },
        transaction
      });

      if (!creatorRequest) {
        await safeTransactionRollback(transaction, logger);
        return res.status(404).json({ error: 'Credit request not found' });
      }

      // Update the request
      await creatorRequest.update({
        creatorId,
        creatorName: creator.name,
        isNewRequest: false
      }, { transaction });

      await transaction.commit();

      return res.json({
        message: 'Creator assigned successfully',
        creatorRequest
      });
    } catch (error) {
      await safeTransactionRollback(transaction, logger);
      logger.error('Error assigning creator:', error);
      return res.status(500).json({ error: 'Failed to assign creator' });
    }
  }
);

// Add endpoint to create and assign creator in one step
router.post(
  '/levels/:id/creators',
  ApiDoc({
    operationId: 'postAdminLevelSubmissionCreators',
    summary: 'Create and assign creator',
    description: 'Create creator/team and assign to submission. Body: name, aliases?, role, creditRequestId.',
    tags: ['Admin', 'Submissions'],
    params: { id: stringIdParamSpec },
    requestBody: { description: 'name, aliases, role, creditRequestId', schema: { type: 'object', properties: { name: { type: 'string' }, aliases: { type: 'array', items: { type: 'string' } }, role: { type: 'string' }, creditRequestId: { type: 'number' } }, required: ['name', 'role', 'creditRequestId'] }, required: true },
    responses: { 200: { description: 'Updated submission' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
  let transaction: any;

  try {
    transaction = await sequelize.transaction();
    const { id } = req.params;
    const { name, aliases, role, creditRequestId } = req.body;

    if (!name || !role || !creditRequestId) {
      await safeTransactionRollback(transaction, logger);
      return res.status(400).json({ error: 'Name, role, and credit request ID are required' });
    }

    // Find the submission with both creator and team requests
    const submission = await LevelSubmission.findOne({
      where: { id },
      include: [
        {
          model: LevelSubmissionCreatorRequest,
          as: 'creatorRequests'
        },
        {
          model: LevelSubmissionTeamRequest,
          as: 'teamRequestData'
        }
      ],
      transaction
    });

    if (!submission) {
      await safeTransactionRollback(transaction, logger);
      return res.status(404).json({ error: 'Submission not found' });
    }

    if (role === 'team') {
      // Create or find team without checking isNewRequest
      const [team] = await Team.findOrCreate({
        where: { name: name.trim() },
        transaction
      });

      // Create team aliases if provided
      if (aliases && Array.isArray(aliases) && aliases.length > 0) {
        const aliasRecords = aliases.map((alias: string) => ({
          teamId: team.id,
          name: alias.trim(),
        }));

        await TeamAlias.bulkCreate(aliasRecords, {
          transaction,
          ignoreDuplicates: true
        });
      }

      // Update team request
      await LevelSubmissionTeamRequest.update({
        teamId: team.id,
        teamName: team.name,
        isNewRequest: false
      }, {
        where: { submissionId: parseInt(id) },
        transaction
      });
    } else {
      // Create or find creator without checking isNewRequest
      const [creator] = await Creator.findOrCreate({
        where: { name: name.trim() },
        defaults: {
          verificationStatus: 'pending'
        },
        transaction
      });

      // Update the existing credit request
      await LevelSubmissionCreatorRequest.update({
        creatorId: creator.id,
        creatorName: creator.name,
        isNewRequest: false
      }, {
        where: {
          id: creditRequestId,
          submissionId: parseInt(id)
        },
        transaction
      });
    }

    await transaction.commit();

    // Fetch fresh complete object with all associations AFTER committing the transaction
    const updatedSubmission = await LevelSubmission.findOne({
      where: { id },
      include: [
        {
          model: LevelSubmissionCreatorRequest,
          as: 'creatorRequests',
          include: [{
            model: Creator,
            as: 'creator',
            include: [
              {
                model: User,
                as: 'user',
                attributes: ['id', 'username']
              },
              {
                model: LevelCredit,
                as: 'credits',
                attributes: ['id', 'role']
              }
            ]
          }]
        },
        {
          model: LevelSubmissionTeamRequest,
          as: 'teamRequestData',
          include: [{
            model: Team,
            as: 'team',
            include: [
              {
                model: Creator,
                as: 'teamCreators',
                through: { attributes: [] },
                required: false
              }
            ]
          }]
        }
      ]
    });

    if (!updatedSubmission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    // Process the submission data to match the format used in pending submissions
    const submissionData = updatedSubmission.toJSON();

    // Process creator requests
    submissionData.creatorRequests = submissionData.creatorRequests?.map((request: any) => {
      if (request.creator?.credits) {
        const credits = request.creator.credits;
        const creditStats = {
          charterCount: credits.filter((credit: any) => credit.role === 'charter').length,
          vfxerCount: credits.filter((credit: any) => credit.role === 'vfxer').length,
          totalCredits: credits.length
        };
        request.creator.credits = creditStats;
      }
      return request;
    });

    // Process team request data
    if (submissionData.teamRequestData?.team) {
      const team = submissionData.teamRequestData.team;
      team.credits = {
        totalLevels: team.levels?.length || 0,
        memberCount: team.members?.length || 0
      };
      // Clean up levels array to avoid sending too much data
      delete team.levels;
    }

    return res.json(submissionData);

  } catch (error) {
    await safeTransactionRollback(transaction, logger);
    logger.error('Error creating and assigning creator:', error);
    return res.status(500).json({ error: 'Failed to create and assign creator' });
  }
});

// Add a new creator request
router.post(
  '/levels/:id/creator-requests',
  ApiDoc({
    operationId: 'postAdminLevelSubmissionCreatorRequests',
    summary: 'Add creator request',
    description: 'Add a new creator/team request to submission. Body: role.',
    tags: ['Admin', 'Submissions'],
    params: { id: stringIdParamSpec },
    requestBody: { description: 'role', schema: { type: 'object', properties: { role: { type: 'string' } }, required: ['role'] }, required: true },
    responses: { 200: { description: 'Updated submission' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
  let transaction: any;

  try {
    transaction = await sequelize.transaction();
    const { id } = req.params;
    const { role } = req.body;

    if (!role) {
      await safeTransactionRollback(transaction, logger);
      return res.status(400).json({ error: 'Role is required' });
    }

    // Find the submission
    const submission = await LevelSubmission.findOne({
      where: { id },
      include: [
        {
          model: LevelSubmissionCreatorRequest,
          as: 'creatorRequests'
        }
      ],
      transaction
    });

    if (!submission) {
      await safeTransactionRollback(transaction, logger);
      return res.status(404).json({ error: 'Submission not found' });
    }

    // Create a new creator request with a placeholder name
    const placeholderName = `New ${role.charAt(0).toUpperCase() + role.slice(1)}`;

    if (role === 'team') {
      await LevelSubmissionTeamRequest.create({
      submissionId: parseInt(id),
      teamName: placeholderName,
      isNewRequest: true
    }, { transaction })
    } else {
      await LevelSubmissionCreatorRequest.create({
      submissionId: parseInt(id),
      role,
      creatorName: placeholderName,
      isNewRequest: true
    }, { transaction });
    }

    await transaction.commit();

    // Fetch updated submission
    const updatedSubmission = await LevelSubmission.findOne({
      where: { id },
      include: [
        {
          model: LevelSubmissionCreatorRequest,
          as: 'creatorRequests',
          include: [{
            model: Creator,
            as: 'creator',
            include: [
              {
                model: User,
                as: 'user',
                attributes: ['id', 'username']
              },
              {
                model: LevelCredit,
                as: 'credits',
                attributes: ['id', 'role']
              }
            ]
          }]
        },
        {
          model: LevelSubmissionTeamRequest,
          as: 'teamRequestData',
          include: [{
            model: Team,
            as: 'team',
            include: [
              {
                model: Creator,
                as: 'teamCreators',
                through: { attributes: [] },
                required: false
              }
            ]
          }]
        }
      ]
    });

    return res.json(updatedSubmission);
  } catch (error) {
    await safeTransactionRollback(transaction, logger);
    logger.error('Error adding creator request:', error);
    return res.status(500).json({ error: 'Failed to add creator request' });
  }
});

// Remove a creator request
router.delete(
  '/levels/:id/creator-requests/:requestId',
  ApiDoc({
    operationId: 'deleteAdminLevelSubmissionCreatorRequest',
    summary: 'Remove creator request',
    description: 'Remove a creator or team request from submission.',
    tags: ['Admin', 'Submissions'],
    params: { id: stringIdParamSpec, requestId: stringIdParamSpec },
    responses: { 200: { description: 'Updated submission' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
  let transaction: any;

  try {
    transaction = await sequelize.transaction();
    const { id, requestId } = req.params;

    // Find the submission
    const submission = await LevelSubmission.findOne({
      where: { id },
      include: [
        {
          model: LevelSubmissionCreatorRequest,
          as: 'creatorRequests'
        },
        {
          model: LevelSubmissionTeamRequest,
          as: 'teamRequestData'
        }
      ],
      transaction
    });

    if (!submission || !submission.creatorRequests) {
      await safeTransactionRollback(transaction, logger);
      return res.status(404).json({ error: 'Submission not found' });
    }

    // First check if this is a team request
    const teamRequest = await LevelSubmissionTeamRequest.findOne({
      where: { id: parseInt(requestId), submissionId: id },
      transaction
    });

    if (teamRequest) {
      // Handle team request deletion
      await LevelSubmissionTeamRequest.destroy({
        where: {
          id: requestId,
          submissionId: id
        },
        transaction
      });
    } else {
      // Handle creator request deletion
      const request = submission.creatorRequests.find(r => r.id === parseInt(requestId));
      const isCharter = request?.role === CreditRole.CHARTER;

      if (isCharter) {
        const charterCount = submission.creatorRequests.filter(r => r.role === CreditRole.CHARTER).length;
        if (charterCount <= 1) {
          await safeTransactionRollback(transaction, logger);
          return res.status(400).json({ error: 'Cannot remove the last charter' });
        }
      }

      // Delete the creator request
      await LevelSubmissionCreatorRequest.destroy({
        where: {
          id: requestId,
          submissionId: id
        },
        transaction
      });
    }

    await transaction.commit();

    // Return the updated submission
    const updatedSubmission = await LevelSubmission.findOne({
      where: { id },
      include: [
        {
          model: LevelSubmissionCreatorRequest,
          as: 'creatorRequests'
        },
        {
          model: LevelSubmissionTeamRequest,
          as: 'teamRequestData'
        }
      ]
    });

    return res.json(updatedSubmission);
  } catch (error) {
    await safeTransactionRollback(transaction, logger);
    logger.error('Error removing creator request:', error);
    return res.status(500).json({ error: 'Failed to remove creator request' });
  }
});

// Mount song/artist management routes (submissions-song-artist.ts)
router.use('/', submissionSongArtistRoutes);

export default router;
