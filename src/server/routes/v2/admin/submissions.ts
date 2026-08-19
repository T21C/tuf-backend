import {Request, Response, Router} from 'express';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import { standardErrorResponses, standardErrorResponses404500, standardErrorResponses500, stringIdParamSpec } from '@/server/schemas/v2/admin/index.js';
import {
  PassSubmission,
  PassSubmissionFlags,
  PassSubmissionJudgements,
} from '@/models/submissions/PassSubmission.js';
import Level from '@/models/levels/Level.js';
import Difficulty from '@/models/levels/Difficulty.js';
import {
  computePassScoreV2,
  PassScoreCalculationError,
} from '@/misc/utils/pass/scoreService.js';
import {deriveKeyFlags, normalizeKeyCount} from '@/misc/utils/pass/keyCount.js';
import sequelize from '@/config/db.js';
import {sseManager, SSE_SOURCES} from '@/misc/utils/server/sse.js';
import {IPassSubmissionJudgements} from '@/server/interfaces/models/index.js';
import LevelSubmission from '@/models/submissions/LevelSubmission.js';
import Player from '@/models/players/Player.js';
import Team from '@/models/credits/Team.js';
import LevelSubmissionCreatorRequest from '@/models/submissions/LevelSubmissionCreatorRequest.js';
import LevelSubmissionTeamRequest from '@/models/submissions/LevelSubmissionTeamRequest.js';
import Creator from '@/models/credits/Creator.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import User from '@/models/auth/User.js';
import { Op, fn, col } from 'sequelize';
import { logger } from '@/server/services/core/LoggerService.js';
import { safeTransactionRollback } from '@/misc/utils/Utility.js';
import {TeamAlias} from '@/models/credits/TeamAlias.js';
import LevelSubmissionSongRequest from '@/models/submissions/LevelSubmissionSongRequest.js';
import LevelSubmissionArtistRequest from '@/models/submissions/LevelSubmissionArtistRequest.js';
import LevelSubmissionEvidence from '@/models/submissions/LevelSubmissionEvidence.js';
import Song from '@/models/songs/Song.js';
import Artist from '@/models/artists/Artist.js';
import SongCredit from '@/models/songs/SongCredit.js';
import {
  resolveOrCreateTeamByName,
  TeamMutationError,
} from '@/server/services/teams/teamMutations.js';
import {
  replaceTeamAliases,
  validateTeamAliasList,
} from '@/server/services/teams/teamAliases.js';
import submissionSongArtistRoutes from './submissions-song-artist.js';
import { sanitizeJudgementInt } from '@/misc/utils/pass/SanitizeJudgements.js';
import { SubmissionJobService } from '@/server/services/submissions/SubmissionJobService.js';
import type { SubmissionAction, SubmissionKind } from '@/server/services/submissions/submissionJobTypes.js';

const router: Router = Router();

enum CreditRole {
  CHARTER = 'charter',
  VFXER = 'vfxer',
  TEAM = 'team'
}

function submissionQueueActor(req: Request): {
  id: string;
  username?: string | null;
  nickname?: string | null;
} {
  return {
    id: String(req.user?.id || ''),
    username: req.user?.username,
    nickname: req.user?.nickname,
  };
}

function levelSubmissionLabel(row: { song?: string | null; artist?: string | null; id: number }): string {
  const song = row.song || '';
  const artist = row.artist || '';
  if (song && artist) return `${song} — ${artist}`;
  return song || artist || `#${row.id}`;
}

function passSubmissionLabel(row: { title?: string | null; passer?: string | null; id: number }): string {
  return row.title || row.passer || `#${row.id}`;
}

async function enqueueSubmissionItems(
  req: Request,
  res: Response,
  options: {
    kind: SubmissionKind;
    action: SubmissionAction;
    itemIds: number[];
    origin?: 'manual' | 'auto';
    labelsByItemId: Map<number, string>;
    levelIdsByItemId?: Map<number, number>;
  },
): Promise<Response> {
  try {
    const result = await SubmissionJobService.createOrMergeRequest({
      kind: options.kind,
      action: options.action,
      itemIds: options.itemIds,
      labelsByItemId: options.labelsByItemId,
      levelIdsByItemId: options.levelIdsByItemId,
      origin: options.origin,
      user: submissionQueueActor(req),
    });
    const alreadyInFlight = result.alreadyInFlightIds.length > 0;
    return res.status(202).json({
      requestId: result.requestId,
      queued: result.addedItemCount > 0,
      alreadyInFlight: alreadyInFlight || undefined,
      addedItemIds: result.addedItemIds,
      alreadyInFlightIds: result.alreadyInFlightIds,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to enqueue submission job', {
      kind: options.kind,
      action: options.action,
      itemIds: options.itemIds,
      error: message,
    });
    const unavailable = message.includes('Redis unavailable');
    return res.status(unavailable ? 503 : 500).json({
      error: unavailable ? 'Submission queue unavailable' : 'Failed to enqueue submission',
      details: message,
    });
  }
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

function buildKeyCountUpdateFields(keyCountBody: unknown): {
  keyCount: number | null;
  is12K: boolean;
  is16K: boolean;
} {
  const keyCount = normalizeKeyCount(keyCountBody);
  const derived = deriveKeyFlags(keyCount);
  return { keyCount, is12K: derived.is12K, is16K: derived.is16K };
}

interface SubmitterRecordStats {
  accepted: number;
  declined: number;
}

interface SubmitterStatusCountRow {
  userId: string;
  status: string;
  count: string | number;
}

async function getSubmitterRecordStats(
  model: typeof LevelSubmission | typeof PassSubmission,
  userIds: Array<string | null | undefined>,
): Promise<Map<string, SubmitterRecordStats>> {
  const stats = new Map<string, SubmitterRecordStats>();
  const uniqueIds = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  if (uniqueIds.length === 0) {
    return stats;
  }

  for (const id of uniqueIds) {
    stats.set(id, { accepted: 0, declined: 0 });
  }

  const rows = (await (model as typeof LevelSubmission).findAll({
    where: {
      userId: { [Op.in]: uniqueIds },
      status: { [Op.in]: ['approved', 'declined'] },
    },
    attributes: [
      'userId',
      'status',
      [fn('COUNT', col('id')), 'count'],
    ],
    group: ['userId', 'status'],
    raw: true,
  })) as unknown as SubmitterStatusCountRow[];

  for (const row of rows) {
    const current = stats.get(row.userId);
    if (!current) continue;
    const count = Number(row.count) || 0;
    if (row.status === 'approved') current.accepted = count;
    else if (row.status === 'declined') current.declined = count;
  }

  return stats;
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

    const recordStats = await getSubmitterRecordStats(
      LevelSubmission,
      pendingLevelSubmissions.map((submission) => submission.userId),
    );

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

      if (submissionData.levelSubmitter) {
        (submissionData.levelSubmitter as { submissionStats?: SubmitterRecordStats }).submissionStats =
          recordStats.get(submissionData.levelSubmitter.id) || { accepted: 0, declined: 0 };
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

      const recordStats = await getSubmitterRecordStats(
        PassSubmission,
        submissions.map((submission) => submission.userId),
      );

      const submissionsWithStats = submissions.map((submission) => {
        const submissionData = submission.toJSON() as { passSubmitter?: { id: string; submissionStats?: SubmitterRecordStats } };
        if (submissionData.passSubmitter) {
          submissionData.passSubmitter.submissionStats =
            recordStats.get(submissionData.passSubmitter.id) || { accepted: 0, declined: 0 };
        }
        return submissionData;
      });

      return res.json(submissionsWithStats);
    } catch (error) {
      logger.error('Error fetching pending pass submissions:', error);
      return res
        .status(500)
        .json({error: 'Failed to fetch pending pass submissions'});
    }
  }
);

router.get(
  '/jobs',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'getAdminSubmissionJobs',
    summary: 'Get submission job snapshot',
    description: 'Open and recent sequential submission processing jobs. Super admin.',
    tags: ['Admin', 'Submissions'],
    security: ['bearerAuth'],
    responses: { 200: { description: 'Snapshot' }, ...standardErrorResponses500 },
  }),
  async (_req: Request, res: Response) => {
    try {
      const snapshot = await SubmissionJobService.getSnapshot();
      return res.json(snapshot);
    } catch (error) {
      logger.error('Error fetching submission jobs:', error);
      return res.status(500).json({ error: 'Failed to fetch submission jobs' });
    }
  },
);

router.put(
  '/levels/:id/approve',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'putAdminLevelSubmissionApprove',
    summary: 'Approve level submission',
    description: 'Enqueue pending level submission approval. Super admin.',
    tags: ['Admin', 'Submissions'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    responses: { 202: { description: 'Queued' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    const submission = await LevelSubmission.findOne({
      where: { [Op.and]: [{ id }, { status: 'pending' }] },
    });
    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }
    return enqueueSubmissionItems(req, res, {
      kind: 'level',
      action: 'approve',
      itemIds: [id],
      labelsByItemId: new Map([[id, levelSubmissionLabel(submission)]]),
    });
  },
);

router.put(
  '/levels/:id/decline',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'putAdminLevelSubmissionDecline',
    summary: 'Decline level submission',
    description: 'Enqueue pending level submission decline. Super admin.',
    tags: ['Admin', 'Submissions'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    responses: { 202: { description: 'Queued' }, ...standardErrorResponses404500 },
  }),
  async (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    const submission = await LevelSubmission.findOne({
      where: { [Op.and]: [{ id }, { status: 'pending' }] },
    });
    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }
    return enqueueSubmissionItems(req, res, {
      kind: 'level',
      action: 'decline',
      itemIds: [id],
      labelsByItemId: new Map([[id, levelSubmissionLabel(submission)]]),
    });
  },
);

router.put(
  '/passes/:id/approve',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'putAdminPassSubmissionApprove',
    summary: 'Approve pass submission',
    description: 'Enqueue pending pass submission approval. Super admin.',
    tags: ['Admin', 'Submissions'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    responses: { 202: { description: 'Queued' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    const submission = await PassSubmission.findOne({
      where: { [Op.and]: [{ id }, { status: 'pending' }] },
    });
    if (!submission) {
      return res.status(404).json({ error: 'Submission not found or already processed' });
    }
    return enqueueSubmissionItems(req, res, {
      kind: 'pass',
      action: 'approve',
      itemIds: [id],
      labelsByItemId: new Map([[id, passSubmissionLabel(submission)]]),
      levelIdsByItemId: submission.levelId
        ? new Map([[id, submission.levelId]])
        : undefined,
    });
  },
);

router.put(
  '/passes/:id/decline',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'putAdminPassSubmissionDecline',
    summary: 'Decline pass submission',
    description: 'Enqueue pending pass submission decline. Super admin.',
    tags: ['Admin', 'Submissions'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    responses: { 202: { description: 'Queued' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    const submission = await PassSubmission.findOne({
      where: { [Op.and]: [{ id }, { status: 'pending' }] },
    });
    if (!submission) {
      return res.status(404).json({ error: 'Submission not found or already processed' });
    }
    return enqueueSubmissionItems(req, res, {
      kind: 'pass',
      action: 'decline',
      itemIds: [id],
      labelsByItemId: new Map([[id, passSubmissionLabel(submission)]]),
      levelIdsByItemId: submission.levelId
        ? new Map([[id, submission.levelId]])
        : undefined,
    });
  },
);

router.put(
  '/passes/:id([0-9]{1,20})',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'putAdminPassSubmissionPartial',
    summary: 'Partially update pending pass submission',
    description:
      'Update levelId, speed, judgements, keyCount, flags, and/or videoLink on a pending pass submission. Omitted nested keys are unchanged. keyCount syncs is12K/is16K flags. Super admin.',
    tags: ['Admin', 'Submissions'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    requestBody: {
      description:
        'Partial fields: levelId (number), speed (number), keyCount (number|null), judgements (partial object), flags (partial object), videoLink (string). At least one required.',
      schema: {
        type: 'object',
        properties: {
          levelId: { type: 'number' },
          speed: { type: 'number' },
          keyCount: { type: 'integer', nullable: true },
          videoLink: { type: 'string' },
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
              isAdofaiV2: { type: 'boolean' },
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
        keyCount?: unknown;
        videoLink?: unknown;
        judgements?: Record<string, unknown>;
        flags?: Record<string, unknown>;
      };

      const hasLevelId = Object.prototype.hasOwnProperty.call(body, 'levelId');
      const hasSpeed = Object.prototype.hasOwnProperty.call(body, 'speed');
      const hasKeyCount = Object.prototype.hasOwnProperty.call(body, 'keyCount');
      const hasJudgements = Object.prototype.hasOwnProperty.call(body, 'judgements');
      const hasFlags = Object.prototype.hasOwnProperty.call(body, 'flags');
      const hasVideoLink = Object.prototype.hasOwnProperty.call(body, 'videoLink');

      if (!hasLevelId && !hasSpeed && !hasKeyCount && !hasJudgements && !hasFlags && !hasVideoLink) {
        await safeTransactionRollback(transaction, logger);
        return res.status(400).json({
          error:
            'Request body must include at least one of: levelId, speed, keyCount, judgements, flags, videoLink',
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

      if (hasVideoLink) {
        const normalized =
          typeof body.videoLink === 'string' ? body.videoLink.trim() : '';
        if (!normalized) {
          await safeTransactionRollback(transaction, logger);
          return res.status(400).json({ error: 'videoLink must be a non-empty string' });
        }
        await submission.update({ videoLink: normalized }, { transaction });
      }

      if (hasKeyCount) {
        const keyCountFields = buildKeyCountUpdateFields(body.keyCount);
        await submission.update({ keyCount: keyCountFields.keyCount }, { transaction });
        await submission.flags.update(
          { is12K: keyCountFields.is12K, is16K: keyCountFields.is16K },
          { transaction },
        );
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
        const patch: Partial<{ is12K: boolean; isNoHoldTap: boolean; is16K: boolean; isAdofaiV2: boolean }> = {};
        if (Object.prototype.hasOwnProperty.call(f, 'is12K')) {
          patch.is12K = f.is12K === true || f.is12K === 'true';
        }
        if (Object.prototype.hasOwnProperty.call(f, 'isNoHoldTap')) {
          patch.isNoHoldTap = f.isNoHoldTap === true || f.isNoHoldTap === 'true';
        }
        if (Object.prototype.hasOwnProperty.call(f, 'is16K')) {
          patch.is16K = f.is16K === true || f.is16K === 'true';
        }
        if (Object.prototype.hasOwnProperty.call(f, 'isAdofaiV2')) {
          patch.isAdofaiV2 = f.isAdofaiV2 === true || f.isAdofaiV2 === 'true';
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
          await safeTransactionRollback(transaction, logger);
          if (err instanceof PassScoreCalculationError) {
            return res.status(400).json({ error: err.message });
          }
          throw err;
        }

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

      sseManager.broadcastToSources([SSE_SOURCES.admin], {
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

      sseManager.broadcastToSources([SSE_SOURCES.admin], {
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
    description: 'Enqueue all pending pass submissions that have an assigned player. Super admin.',
    tags: ['Admin', 'Submissions'],
    security: ['bearerAuth'],
    responses: { 202: { description: 'Queued' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
    try {
      const pendingSubmissions = await PassSubmission.findAll({
        where: { status: 'pending', assignedPlayerId: { [Op.ne]: null } },
        attributes: ['id', 'title', 'passer', 'levelId'],
      });
      if (pendingSubmissions.length === 0) {
        return res.status(202).json({
          requestId: null,
          queued: false,
          addedItemIds: [],
        });
      }
      const labelsByItemId = new Map<number, string>();
      const levelIdsByItemId = new Map<number, number>();
      for (const row of pendingSubmissions) {
        labelsByItemId.set(row.id, passSubmissionLabel(row));
        if (row.levelId) levelIdsByItemId.set(row.id, row.levelId);
      }
      return enqueueSubmissionItems(req, res, {
        kind: 'pass',
        action: 'approve',
        origin: 'auto',
        itemIds: pendingSubmissions.map(row => row.id),
        labelsByItemId,
        levelIdsByItemId,
      });
    } catch (error) {
      const errorDetails = extractErrorDetails(error);
      logger.error('Error in auto-approve enqueue:', {
        errorMessage: errorDetails.message,
      });
      return res.status(500).json({
        error: 'Failed to auto-approve submissions',
        details: errorDetails.message,
      });
    }
  },
);


// Add endpoint to update profiles
router.put(
  '/levels/:id/profiles',
  Auth.superAdmin(),
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
  Auth.superAdmin(),
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
      let team;
      try {
        team = await resolveOrCreateTeamByName(name.trim(), transaction);
      } catch (error) {
        if (error instanceof TeamMutationError) {
          await safeTransactionRollback(transaction, logger);
          return res.status(error.status).json({ error: error.message });
        }
        throw error;
      }

      // Create team aliases if provided
      if (aliases && Array.isArray(aliases) && aliases.length > 0) {
        const aliasResult = await validateTeamAliasList(
          sequelize,
          team.id,
          team.name,
          aliases,
          transaction,
        );
        if (!aliasResult.ok) {
          await safeTransactionRollback(transaction, logger);
          return res.status(400).json({ error: aliasResult.error });
        }
        // Merge with existing aliases (preserve prior; add validated new names)
        const existing = await TeamAlias.findAll({
          where: { teamId: team.id },
          attributes: ['name'],
          transaction,
        });
        const merged = [...new Set([
          ...existing.map(a => a.name),
          ...aliasResult.names,
        ])];
        const mergedResult = await validateTeamAliasList(
          sequelize,
          team.id,
          team.name,
          merged,
          transaction,
        );
        if (!mergedResult.ok) {
          await safeTransactionRollback(transaction, logger);
          return res.status(400).json({ error: mergedResult.error });
        }
        await replaceTeamAliases(team.id, mergedResult.names, transaction);
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
  Auth.superAdmin(),
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
  Auth.superAdmin(),
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
