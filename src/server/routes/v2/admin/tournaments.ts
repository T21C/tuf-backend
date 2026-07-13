import {Router, Request, Response} from 'express';
import multer from 'multer';
import {Op} from 'sequelize';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {logger} from '@/server/services/core/LoggerService.js';
import TournamentSeries from '@/models/tournaments/TournamentSeries.js';
import Tournament from '@/models/tournaments/Tournament.js';
import TournamentTier from '@/models/tournaments/TournamentTier.js';
import TournamentPlacement from '@/models/tournaments/TournamentPlacement.js';
import PlacementReward from '@/models/tournaments/PlacementReward.js';
import Player from '@/models/players/Player.js';
import Creator from '@/models/credits/Creator.js';
import User from '@/models/auth/User.js';
import {
  TIER_TEMPLATES,
  getTierTemplate,
  inferTierFromCode,
  parsePrizeCode,
  tierMetaFromLabel,
  tierCodeFromLabel,
  MAX_TIER_CODE_LENGTH,
} from '@/server/services/tournaments/tierTemplates.js';
import {
  buildNameLookupMaps,
  lookupNameId,
  resolvePlacementName,
} from '@/server/services/tournaments/PlacementNameResolver.js';
import {PlacementRewardService} from '@/server/services/tournaments/PlacementRewardService.js';
import {PlacementCreditService} from '@/server/services/tournaments/PlacementCreditService.js';
import {TournamentPackImportService} from '@/server/services/tournaments/TournamentPackImportService.js';
import {TournamentPackCreateService} from '@/server/services/tournaments/TournamentPackCreateService.js';
import {TournamentCsvImportService} from '@/server/services/tournaments/TournamentCsvImportService.js';
import {TournamentDeletionService} from '@/server/services/tournaments/TournamentDeletionService.js';
import {
  normalizeCreditRoleFilter,
  normalizeCreditedCreatorIds,
  resolveEffectiveRowMode,
} from '@/server/services/tournaments/placementModeUtils.js';
import {
  canEditTournamentVisuals,
  normalizeOwnerUserIds,
} from '@/server/services/tournaments/tournamentOwnership.js';
import LevelCredit, {CreditRole} from '@/models/levels/LevelCredit.js';
import Level from '@/models/levels/Level.js';
import cdnService, {CdnError} from '@/server/services/core/CdnService.js';
import {getSequelizeForModelGroup} from '@/config/db.js';
import {hasFlag} from '@/misc/utils/auth/permissionUtils.js';
import {permissionFlags} from '@/config/constants.js';
import {respondMysqlClientError} from '@/misc/utils/db/mysqlClientError.js';


const router: Router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {fileSize: 10 * 1024 * 1024},
});

const rewardService = PlacementRewardService.getInstance();
const creditService = PlacementCreditService.getInstance();
const csvImportService = TournamentCsvImportService.getInstance();
const packImportService = TournamentPackImportService.getInstance();
const packCreateService = TournamentPackCreateService.getInstance();
const deletionService = TournamentDeletionService.getInstance();

async function loadTournamentOwners(ownerUserIds: unknown) {
  const ids = normalizeOwnerUserIds(ownerUserIds);
  if (!ids.length) return [];
  const users = await User.findAll({
    where: {id: {[Op.in]: ids}},
    attributes: ['id', 'username', 'nickname', 'avatarUrl'],
  });
  const byId = new Map(users.map(u => [String(u.id), u]));
  return ids.map(id => {
    const user = byId.get(id);
    return {
      id,
      username: user?.username ?? null,
      nickname: user?.nickname ?? null,
      avatarUrl: user?.avatarUrl ?? null,
    };
  });
}

async function requireTournamentVisualAccess(
  req: Request,
  res: Response,
  tournamentId: number,
): Promise<Tournament | null> {
  const tournament = await Tournament.findByPk(tournamentId);
  if (!tournament) {
    res.status(404).json({error: 'Tournament not found'});
    return null;
  }
  if (!canEditTournamentVisuals(req.user, tournament)) {
    res.status(403).json({error: 'Tournament visual editor access required'});
    return null;
  }
  return tournament;
}

const placementDetailInclude = [
  {model: TournamentTier, as: 'tier'},
  {
    model: Player,
    as: 'player',
    required: false,
    attributes: ['id', 'name'],
  },
  {
    model: Creator,
    as: 'creator',
    required: false,
    attributes: ['id', 'name'],
  },
  {
    model: Level,
    as: 'level',
    required: false,
    attributes: ['id', 'song', 'artist', 'diffId', 'team'],
    include: [
      {
        model: LevelCredit,
        as: 'levelCredits',
        required: false,
        include: [
          {
            model: Creator,
            as: 'creator',
            required: false,
            attributes: ['id', 'name'],
          },
        ],
      },
    ],
  },
];

function parseOrderedIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map(Number).filter(n => Number.isFinite(n) && n > 0);
}

async function loadNomineeCandidates(
  levelId: number,
  roles: CreditRole[],
): Promise<
  Array<{
    creatorId: number;
    creatorName: string | null;
    name: string | null;
    role: string;
    sortOrder: number;
    isOnLevel: boolean;
    avatarUrl: string | null;
    username: string | null;
    nickname: string | null;
  }>
> {
  const credits = await LevelCredit.findAll({
    where: {
      levelId,
      role: roles.length
        ? {[Op.in]: roles}
        : {[Op.in]: [CreditRole.CHARTER, CreditRole.VFXER]},
    },
    include: [
      {
        model: Creator,
        as: 'creator',
        required: true,
        attributes: ['id', 'name'],
        include: [
          {
            model: User,
            as: 'user',
            required: false,
            attributes: ['id', 'username', 'nickname', 'avatarUrl', 'avatarIsGif'],
          },
        ],
      },
    ],
    order: [
      ['sortOrder', 'ASC'],
      ['creatorId', 'ASC'],
    ],
  });

  const seen = new Set<number>();
  const candidates = [];
  for (const credit of credits) {
    if (seen.has(credit.creatorId)) continue;
    seen.add(credit.creatorId);
    const creator = (credit as any).creator as Creator & {
      user?: Pick<User, 'username' | 'nickname' | 'avatarUrl' | 'avatarIsGif'> | null;
    };
    const user = creator?.user ?? null;
    const creatorName = creator?.name ?? null;
    candidates.push({
      creatorId: credit.creatorId,
      creatorName,
      name: creatorName,
      role: credit.role,
      sortOrder: credit.sortOrder,
      isOnLevel: true,
      avatarUrl: user?.avatarUrl ?? null,
      username: user?.username ?? null,
      nickname: user?.nickname ?? null,
    });
  }
  return candidates;
}

async function deleteCdnAssetIfExists(assetId: string | null | undefined): Promise<void> {
  if (!assetId) return;
  try {
    if (await cdnService.checkFileExists(assetId)) {
      await cdnService.deleteFile(assetId);
    }
  } catch (delErr) {
    logger.error('Error deleting CDN asset:', delErr);
  }
}

async function uploadTournamentVisual(
  file: {buffer: Buffer; originalname: string},
  kind: 'icon' | 'card',
): Promise<{fileId: string; url: string}> {
  const uploadFn =
    kind === 'icon'
      ? cdnService.uploadTournamentPlacementIcon.bind(cdnService)
      : cdnService.uploadTournamentPlacementCard.bind(cdnService);
  const result = await uploadFn(file.buffer, file.originalname);
  const url =
    kind === 'icon'
      ? (result.urls?.medium ?? result.urls?.original ?? result.urls?.small ?? null)
      : (result.urls?.large ?? result.urls?.original ?? null);
  if (!url) {
    throw Object.assign(new Error('CDN did not return asset URL'), {code: 500});
  }
  return {fileId: result.fileId, url};
}

// ── Series ──────────────────────────────────────────────────────────

router.get(
  '/series',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminListTournamentSeries',
    summary: 'List tournament series',
    tags: ['Admin', 'Tournaments'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Series list'}},
  }),
  async (_req: Request, res: Response) => {
    try {
      const series = await TournamentSeries.findAll({order: [['sortWeight', 'ASC']]});
      return res.json(series);
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to list series', {
        logLabel: 'List tournament series failed:',
      });
    }
  },
);

router.post(
  '/series',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminCreateTournamentSeries',
    summary: 'Create tournament series',
    tags: ['Admin', 'Tournaments'],
    security: ['bearerAuth'],
    responses: {201: {description: 'Created'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const slug = String(req.body.slug || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-');
      const name = String(req.body.name || '').trim();
      if (!slug || !name) {
        return res.status(400).json({error: 'slug and name are required'});
      }
      const series = await TournamentSeries.create({
        slug,
        name,
        description: req.body.description ?? null,
        logoUrl: req.body.logoUrl ?? null,
      });
      return res.status(201).json(series);
    } catch (error: any) {
      return respondMysqlClientError(res, error, 'Failed to create series', {
        uniqueMessage: 'Series slug already exists',
        logLabel: 'Create tournament series failed:',
      });
    }
  },
);

router.put(
  '/series/reorder',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const orderedIds = parseOrderedIds(req.body.orderedIds);
      if (!orderedIds.length) {
        return res.status(400).json({error: 'orderedIds must be a non-empty array'});
      }
      for (let i = 0; i < orderedIds.length; i++) {
        await TournamentSeries.update(
          {sortWeight: i + 1},
          {where: {id: orderedIds[i]}},
        );
      }
      const series = await TournamentSeries.findAll({order: [['sortWeight', 'ASC']]});
      return res.json(series);
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to reorder series', {
        logLabel: 'Reorder tournament series failed:',
      });
    }
  },
);

router.patch(
  '/series/:id([0-9]{1,20})',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const series = await TournamentSeries.findByPk(req.params.id);
      if (!series) return res.status(404).json({error: 'Series not found'});
      const updates: Record<string, unknown> = {};
      if (req.body.name != null) updates.name = String(req.body.name).trim();
      if (req.body.description !== undefined) updates.description = req.body.description;
      if (req.body.logoUrl !== undefined) updates.logoUrl = req.body.logoUrl;
      if (req.body.slug != null) {
        updates.slug = String(req.body.slug)
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, '-');
      }
      await series.update(updates);
      return res.json(series);
    } catch (error: any) {
      return respondMysqlClientError(res, error, 'Failed to update series', {
        uniqueMessage: 'Series slug already exists',
        logLabel: 'Update tournament series failed:',
      });
    }
  },
);

router.delete(
  '/series/:id([0-9]{1,20})',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const series = await TournamentSeries.findByPk(req.params.id);
      if (!series) return res.status(404).json({error: 'Series not found'});
      await series.destroy();
      return res.json({success: true});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to delete series', {
        logLabel: 'Delete tournament series failed:',
      });
    }
  },
);

// ── Tier templates ──────────────────────────────────────────────────

router.get('/tier-templates', Auth.superAdmin(), async (_req, res) => {
  return res.json(TIER_TEMPLATES);
});

// ── Tournaments list / CRUD ─────────────────────────────────────────

router.get(
  '/',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const where: Record<string, unknown> = {};
      if (req.query.status) where.status = String(req.query.status);
      if (req.query.seriesId) where.seriesId = parseInt(String(req.query.seriesId), 10);
      if (req.query.isHidden === 'true') where.isHidden = true;
      if (req.query.isHidden === 'false') where.isHidden = false;

      const search = String(req.query.search || '').trim();
      if (search) {
        where[Op.or as any] = [
          {shortName: {[Op.like]: `%${search}%`}},
          {fullName: {[Op.like]: `%${search}%`}},
          {aka: {[Op.like]: `%${search}%`}},
        ];
      }

      const sequelize = getSequelizeForModelGroup('tournaments');
      const tournaments = await Tournament.findAll({
        where,
        include: [
          {model: TournamentSeries, as: 'series', required: false},
          {model: TournamentTier, as: 'tiers', required: false},
        ],
        order: [
          [sequelize.literal('COALESCE(`series`.`sortWeight`, 100)'), 'ASC'],
          ['sortWeight', 'ASC'],
          ['sortYear', 'DESC'],
          ['shortName', 'ASC'],
        ],
      });

      const placementCounts = await TournamentPlacement.findAll({
        attributes: [
          'tournamentId',
          [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
        ],
        group: ['tournamentId'],
        raw: true,
      });

      const countMap = new Map(
        (placementCounts as any[]).map(r => [r.tournamentId, Number(r.count)]),
      );

      return res.json(
        tournaments.map(t => ({
          ...t.toJSON(),
          placementCount: countMap.get(t.id) ?? 0,
        })),
      );
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to list tournaments', {
        logLabel: 'List tournaments failed:',
      });
    }
  },
);

router.put(
  '/reorder',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const orderedIds = parseOrderedIds(req.body.orderedIds);
      if (!orderedIds.length) {
        return res.status(400).json({error: 'orderedIds must be a non-empty array'});
      }
      for (let i = 0; i < orderedIds.length; i++) {
        await Tournament.update(
          {sortWeight: i + 1},
          {where: {id: orderedIds[i]}},
        );
      }
      const tournaments = await Tournament.findAll({
        where: {id: {[Op.in]: orderedIds}},
        order: [['sortWeight', 'ASC']],
      });
      return res.json(tournaments);
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to reorder tournaments', {
        logLabel: 'Reorder tournaments failed:',
      });
    }
  },
);

router.get(
  '/levels/:levelId([0-9]{1,20})/credit-candidates',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const levelId = parseInt(req.params.levelId, 10);
      const roleFilter = normalizeCreditRoleFilter(req.query.roles);
      const roles = roleFilter.filter(
        (r): r is CreditRole => r === CreditRole.CHARTER || r === CreditRole.VFXER,
      );

      const candidates = await loadNomineeCandidates(levelId, roles);
      return res.json(candidates);
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to list credit candidates', {
        logLabel: 'List credit candidates failed:',
      });
    }
  },
);

router.post(
  '/pack-create',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const packRef = String(req.body.packRef || '').trim();
      if (!packRef) return res.status(400).json({error: 'packRef is required'});

      const tournament = await packCreateService.createFromPack({
        packRef,
        shortName: req.body.shortName != null ? String(req.body.shortName).trim() : null,
        fullName: req.body.fullName ?? null,
        aka: req.body.aka ?? null,
        seriesId: req.body.seriesId ?? null,
        status: req.body.status ?? 'draft',
        isHidden: Boolean(req.body.isHidden),
        isResultsFinal: Boolean(req.body.isResultsFinal),
        youtubeUrl: req.body.youtubeUrl ?? null,
        notes: req.body.notes ?? null,
        externalUrl: req.body.externalUrl ?? null,
        organizers: Array.isArray(req.body.organizers) ? req.body.organizers : null,
        sortYear: req.body.sortYear ?? null,
        syncCredits: req.body.syncCredits !== false,
      });
      return res.status(201).json(tournament);
    } catch (error: any) {
      if (error?.code === 404) return res.status(404).json({error: error.message});
      if (error?.code === 400) return res.status(400).json({error: error.message});
      return respondMysqlClientError(res, error, 'Failed to create tournament from pack', {
        uniqueMessage: 'Tournament short name already exists',
        logLabel: 'Pack create failed:',
      });
    }
  },
);

router.get(
  '/:id([0-9]{1,20})',
  Auth.user(),
  async (req: Request, res: Response) => {
    try {
      const tournament = await Tournament.findByPk(req.params.id, {
        include: [
          {model: TournamentSeries, as: 'series', required: false},
          {
            model: TournamentTier,
            as: 'tiers',
            required: false,
            separate: true,
            order: [
              ['rankWeight', 'ASC'],
              ['sortOrder', 'ASC'],
            ],
          },
          {
            model: TournamentPlacement,
            as: 'placements',
            required: false,
            separate: true,
            include: placementDetailInclude,
            order: [
              ['positionInTier', 'ASC'],
              ['id', 'ASC'],
            ],
          },
          {
            model: PlacementReward,
            as: 'rewards',
            required: false,
            separate: true,
          },
        ],
      });
      if (!tournament) return res.status(404).json({error: 'Tournament not found'});
      const isSuperAdmin = hasFlag(req.user, permissionFlags.SUPER_ADMIN);
      if (!isSuperAdmin && !canEditTournamentVisuals(req.user, tournament)) {
        return res.status(403).json({error: 'Access denied'});
      }
      const owners = await loadTournamentOwners(tournament.ownerUserIds);
      return res.json({
        ...tournament.toJSON(),
        owners,
      });
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to get tournament', {
        logLabel: 'Get tournament failed:',
      });
    }
  },
);

router.post(
  '/',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const shortName = String(req.body.shortName || '').trim();
      if (!shortName) {
        return res.status(400).json({error: 'shortName is required'});
      }

      const placementMode =
        req.body.placementMode === 'level' || req.body.placementMode === 'profile'
          ? req.body.placementMode
          : 'profile';
      const track = req.body.track === 'creator' ? 'creator' : 'player';
      const ownerUserIds = normalizeOwnerUserIds(req.body.ownerUserIds);

      const tournament = await Tournament.create({
        shortName,
        fullName: req.body.fullName ?? null,
        aka: req.body.aka ?? null,
        seriesId: req.body.seriesId ?? null,
        status: req.body.status ?? 'draft',
        isHidden: Boolean(req.body.isHidden),
        isResultsFinal: Boolean(req.body.isResultsFinal),
        youtubeUrl: req.body.youtubeUrl ?? null,
        packRef: req.body.packRef ?? null,
        notes: req.body.notes ?? null,
        externalUrl: req.body.externalUrl ?? null,
        organizers: Array.isArray(req.body.organizers) ? req.body.organizers : null,
        ownerUserIds: ownerUserIds.length ? ownerUserIds : null,
        startsAt: req.body.startsAt ?? null,
        endsAt: req.body.endsAt ?? null,
        sortYear: req.body.sortYear ?? null,
        track,
        placementMode,
        showBestTiersOnly: req.body.showBestTiersOnly !== false,
      });

      const templateId = String(req.body.tierTemplateId || 'podium4');
      const template = getTierTemplate(templateId);
      if (template?.tiers.length) {
        await TournamentTier.bulkCreate(
          template.tiers.map(t => ({
            tournamentId: tournament.id,
            ...t,
          })),
        );
      }

      const full = await Tournament.findByPk(tournament.id, {
        include: [
          {model: TournamentTier, as: 'tiers'},
          {model: TournamentSeries, as: 'series'},
        ],
      });
      return res.status(201).json(full);
    } catch (error: any) {
      return respondMysqlClientError(res, error, 'Failed to create tournament', {
        uniqueMessage: 'Tournament short name already exists',
        logLabel: 'Create tournament failed:',
      });
    }
  },
);

router.patch(
  '/:id([0-9]{1,20})',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const tournament = await Tournament.findByPk(req.params.id);
      if (!tournament) return res.status(404).json({error: 'Tournament not found'});

      const fields = [
        'shortName',
        'fullName',
        'aka',
        'seriesId',
        'status',
        'isHidden',
        'isResultsFinal',
        'youtubeUrl',
        'packRef',
        'notes',
        'externalUrl',
        'organizers',
        'startsAt',
        'endsAt',
        'sortYear',
      ] as const;

      const updates: Record<string, unknown> = {};
      for (const field of fields) {
        if (req.body[field] !== undefined) updates[field] = req.body[field];
      }
      if (req.body.track === 'player' || req.body.track === 'creator') {
        updates.track = req.body.track;
      }
      if (req.body.ownerUserIds !== undefined) {
        const ownerUserIds = normalizeOwnerUserIds(req.body.ownerUserIds);
        updates.ownerUserIds = ownerUserIds.length ? ownerUserIds : null;
      }
      if (req.body.showBestTiersOnly !== undefined) {
        updates.showBestTiersOnly = Boolean(req.body.showBestTiersOnly);
      }
      if (req.body.placementMode != null) {
        if (req.body.placementMode !== 'profile' && req.body.placementMode !== 'level') {
          return res.status(400).json({error: 'Invalid placementMode'});
        }
        updates.placementMode = req.body.placementMode;
      }

      await tournament.update(updates);

      if (req.body.tierTemplateId) {
        const template = getTierTemplate(String(req.body.tierTemplateId));
        if (template) {
          const existingCodes = new Set(
            (
              await TournamentTier.findAll({
                where: {tournamentId: tournament.id},
                attributes: ['code'],
              })
            ).map(t => t.code.toUpperCase()),
          );
          for (const tier of template.tiers) {
            if (existingCodes.has(tier.code.toUpperCase())) continue;
            await TournamentTier.create({tournamentId: tournament.id, ...tier});
          }
        }
      }

      await rewardService.syncEntitlementsForTournament(tournament.id);

      const full = await Tournament.findByPk(tournament.id, {
        include: [
          {model: TournamentTier, as: 'tiers'},
          {model: TournamentSeries, as: 'series'},
          {model: TournamentPlacement, as: 'placements', include: placementDetailInclude},
        ],
      });
      return res.json(full);
    } catch (error: any) {
      return respondMysqlClientError(res, error, 'Failed to update tournament', {
        uniqueMessage: 'Tournament short name already exists',
        logLabel: 'Update tournament failed:',
      });
    }
  },
);

router.delete(
  '/:id([0-9]{1,20})',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const tournamentId = parseInt(String(req.params.id), 10);
      const existing = await Tournament.findByPk(tournamentId);
      if (!existing) return res.status(404).json({error: 'Tournament not found'});

      const {assetIds} = await deletionService.deleteTournament(tournamentId);
      for (const assetId of assetIds) {
        await deleteCdnAssetIfExists(assetId);
      }
      return res.json({success: true});
    } catch (error: any) {
      if (error?.message === 'Tournament not found') {
        return res.status(404).json({error: 'Tournament not found'});
      }
      return respondMysqlClientError(res, error, 'Failed to delete tournament', {
        logLabel: 'Delete tournament failed:',
      });
    }
  },
);

// ── Tournament & tier visual assets ───────────────────────────────

router.post(
  '/:id([0-9]{1,20})/icon',
  Auth.user(),
  upload.single('asset'),
  async (req: Request, res: Response) => {
    try {
      const tournament = await requireTournamentVisualAccess(
        req,
        res,
        parseInt(req.params.id, 10),
      );
      if (!tournament) return;
      if (!req.file) return res.status(400).json({error: 'No file uploaded'});

      const {fileId, url} = await uploadTournamentVisual(req.file, 'icon');
      const oldId = tournament.iconAssetId;
      await tournament.update({iconAssetId: fileId, iconUrl: url});
      if (oldId && oldId !== fileId) await deleteCdnAssetIfExists(oldId);
      return res.json(tournament);
    } catch (error: any) {
      if (error instanceof CdnError) {
        return res.status(400).json({error: error.message, code: error.code});
      }
      return respondMysqlClientError(res, error, 'Failed to upload tournament icon', {
        logLabel: 'Upload tournament icon failed:',
      });
    }
  },
);

router.post(
  '/:id([0-9]{1,20})/card-background',
  Auth.user(),
  upload.single('asset'),
  async (req: Request, res: Response) => {
    try {
      const tournament = await requireTournamentVisualAccess(
        req,
        res,
        parseInt(req.params.id, 10),
      );
      if (!tournament) return;
      if (!req.file) return res.status(400).json({error: 'No file uploaded'});

      const {fileId, url} = await uploadTournamentVisual(req.file, 'card');
      const oldId = tournament.cardBackgroundAssetId;
      await tournament.update({cardBackgroundAssetId: fileId, cardBackgroundUrl: url});
      if (oldId && oldId !== fileId) await deleteCdnAssetIfExists(oldId);
      return res.json(tournament);
    } catch (error: any) {
      if (error instanceof CdnError) {
        return res.status(400).json({error: error.message, code: error.code});
      }
      return respondMysqlClientError(res, error, 'Failed to upload card background', {
        logLabel: 'Upload tournament card background failed:',
      });
    }
  },
);

router.delete(
  '/:id([0-9]{1,20})/icon',
  Auth.user(),
  async (req: Request, res: Response) => {
    try {
      const tournament = await requireTournamentVisualAccess(
        req,
        res,
        parseInt(req.params.id, 10),
      );
      if (!tournament) return;
      const oldId = tournament.iconAssetId;
      await tournament.update({iconAssetId: null, iconUrl: null});
      await deleteCdnAssetIfExists(oldId);
      return res.json(tournament);
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to remove tournament icon', {
        logLabel: 'Remove tournament icon failed:',
      });
    }
  },
);

router.delete(
  '/:id([0-9]{1,20})/card-background',
  Auth.user(),
  async (req: Request, res: Response) => {
    try {
      const tournament = await requireTournamentVisualAccess(
        req,
        res,
        parseInt(req.params.id, 10),
      );
      if (!tournament) return;
      const oldId = tournament.cardBackgroundAssetId;
      await tournament.update({cardBackgroundAssetId: null, cardBackgroundUrl: null});
      await deleteCdnAssetIfExists(oldId);
      return res.json(tournament);
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to remove card background', {
        logLabel: 'Remove tournament card background failed:',
      });
    }
  },
);

router.post(
  '/:id([0-9]{1,20})/tiers/:tierId([0-9]{1,20})/icon',
  Auth.user(),
  upload.single('asset'),
  async (req: Request, res: Response) => {
    try {
      const tournament = await requireTournamentVisualAccess(
        req,
        res,
        parseInt(req.params.id, 10),
      );
      if (!tournament) return;
      const tier = await TournamentTier.findOne({
        where: {id: req.params.tierId, tournamentId: tournament.id},
      });
      if (!tier) return res.status(404).json({error: 'Tier not found'});
      if (!req.file) return res.status(400).json({error: 'No file uploaded'});

      const {fileId, url} = await uploadTournamentVisual(req.file, 'icon');
      const oldId = tier.iconAssetId;
      await tier.update({iconAssetId: fileId, iconUrl: url});
      if (oldId && oldId !== fileId) await deleteCdnAssetIfExists(oldId);
      return res.json(tier);
    } catch (error: any) {
      if (error instanceof CdnError) {
        return res.status(400).json({error: error.message, code: error.code});
      }
      return respondMysqlClientError(res, error, 'Failed to upload tier icon', {
        logLabel: 'Upload tier icon failed:',
      });
    }
  },
);

router.post(
  '/:id([0-9]{1,20})/tiers/:tierId([0-9]{1,20})/card-background',
  Auth.user(),
  upload.single('asset'),
  async (req: Request, res: Response) => {
    try {
      const tournament = await requireTournamentVisualAccess(
        req,
        res,
        parseInt(req.params.id, 10),
      );
      if (!tournament) return;
      const tier = await TournamentTier.findOne({
        where: {id: req.params.tierId, tournamentId: tournament.id},
      });
      if (!tier) return res.status(404).json({error: 'Tier not found'});
      if (!req.file) return res.status(400).json({error: 'No file uploaded'});

      const {fileId, url} = await uploadTournamentVisual(req.file, 'card');
      const oldId = tier.cardBackgroundAssetId;
      await tier.update({cardBackgroundAssetId: fileId, cardBackgroundUrl: url});
      if (oldId && oldId !== fileId) await deleteCdnAssetIfExists(oldId);
      return res.json(tier);
    } catch (error: any) {
      if (error instanceof CdnError) {
        return res.status(400).json({error: error.message, code: error.code});
      }
      return respondMysqlClientError(res, error, 'Failed to upload tier card background', {
        logLabel: 'Upload tier card background failed:',
      });
    }
  },
);

router.delete(
  '/:id([0-9]{1,20})/tiers/:tierId([0-9]{1,20})/icon',
  Auth.user(),
  async (req: Request, res: Response) => {
    try {
      const tournament = await requireTournamentVisualAccess(
        req,
        res,
        parseInt(req.params.id, 10),
      );
      if (!tournament) return;
      const tier = await TournamentTier.findOne({
        where: {id: req.params.tierId, tournamentId: tournament.id},
      });
      if (!tier) return res.status(404).json({error: 'Tier not found'});
      const oldId = tier.iconAssetId;
      await tier.update({iconAssetId: null, iconUrl: null});
      await deleteCdnAssetIfExists(oldId);
      return res.json(tier);
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to remove tier icon', {
        logLabel: 'Remove tier icon failed:',
      });
    }
  },
);

router.delete(
  '/:id([0-9]{1,20})/tiers/:tierId([0-9]{1,20})/card-background',
  Auth.user(),
  async (req: Request, res: Response) => {
    try {
      const tournament = await requireTournamentVisualAccess(
        req,
        res,
        parseInt(req.params.id, 10),
      );
      if (!tournament) return;
      const tier = await TournamentTier.findOne({
        where: {id: req.params.tierId, tournamentId: tournament.id},
      });
      if (!tier) return res.status(404).json({error: 'Tier not found'});
      const oldId = tier.cardBackgroundAssetId;
      await tier.update({cardBackgroundAssetId: null, cardBackgroundUrl: null});
      await deleteCdnAssetIfExists(oldId);
      return res.json(tier);
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to remove tier card background', {
        logLabel: 'Remove tier card background failed:',
      });
    }
  },
);

// ── Tiers ───────────────────────────────────────────────────────────

router.put(
  '/:id([0-9]{1,20})/tiers',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const tournament = await Tournament.findByPk(req.params.id);
      if (!tournament) return res.status(404).json({error: 'Tournament not found'});

      const tiers = Array.isArray(req.body.tiers) ? req.body.tiers : [];
      const keepIds: number[] = [];
      const usedCodes = new Set<string>();

      for (let i = 0; i < tiers.length; i++) {
        const t = tiers[i];
        const label = String(t.label || '').trim();
        const rawCode = String(t.code || label).trim();
        if (!rawCode) continue;

        const upper = rawCode.toUpperCase();
        let code = upper;
        if (upper.length > MAX_TIER_CODE_LENGTH || usedCodes.has(upper)) {
          code = tierCodeFromLabel(label || rawCode, usedCodes);
        } else {
          usedCodes.add(code);
        }

        const payload = {
          code,
          label: label || code,
          kind: t.kind || inferTierFromCode(code).kind,
          rankWeight: Number.isFinite(t.rankWeight)
            ? t.rankWeight
            : inferTierFromCode(code).rankWeight,
          color: t.color ?? null,
          iconKey: t.iconKey ?? null,
          iconAssetId: t.iconAssetId ?? null,
          iconUrl: t.iconUrl ?? null,
          cardBackgroundAssetId: t.cardBackgroundAssetId ?? null,
          cardBackgroundUrl: t.cardBackgroundUrl ?? null,
          sortOrder: Number.isFinite(t.sortOrder) ? t.sortOrder : i,
        };

        if (t.id) {
          const existing = await TournamentTier.findOne({
            where: {id: t.id, tournamentId: tournament.id},
          });
          if (existing) {
            await existing.update(payload);
            keepIds.push(existing.id);
            continue;
          }
        }

        const created = await TournamentTier.create({
          tournamentId: tournament.id,
          ...payload,
        });
        keepIds.push(created.id);
      }

      await TournamentTier.destroy({
        where: {
          tournamentId: tournament.id,
          ...(keepIds.length ? {id: {[Op.notIn]: keepIds}} : {}),
        },
      });

      const result = await TournamentTier.findAll({
        where: {tournamentId: tournament.id},
        order: [
          ['rankWeight', 'ASC'],
          ['sortOrder', 'ASC'],
        ],
      });
      return res.json(result);
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to update tiers', {
        logLabel: 'Replace tournament tiers failed:',
      });
    }
  },
);

// ── Placements ──────────────────────────────────────────────────────

router.put(
  '/:id([0-9]{1,20})/placements',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const tournament = await Tournament.findByPk(req.params.id);
      if (!tournament) return res.status(404).json({error: 'Tournament not found'});

      const placements = Array.isArray(req.body.placements) ? req.body.placements : [];
      const deletePlacementIds = parseOrderedIds(req.body.deletePlacementIds);
      const autoLink = req.body.autoLink !== false;
      const nameMap = autoLink
        ? await buildNameLookupMaps()
        : new Map<string, number>();

      const tierByCode = new Map<string, TournamentTier>();
      const tiers = await TournamentTier.findAll({
        where: {tournamentId: tournament.id},
      });
      for (const t of tiers) tierByCode.set(t.code.toUpperCase(), t);

      if (deletePlacementIds.length) {
        await TournamentPlacement.destroy({
          where: {
            tournamentId: tournament.id,
            id: {[Op.in]: deletePlacementIds},
          },
        });
      }

      const positionCounters = new Map<string, number>();

      for (const row of placements) {
        let code = String(row.tierCode || row.code || '').trim().toUpperCase();
        let withdrew = Boolean(row.withdrew);
        if (row.prize) {
          const parsed = parsePrizeCode(row.prize);
          code = parsed.code;
          withdrew = withdrew || parsed.withdrew;
        }
        if (!code) continue;

        const displayName = String(row.displayName || row.name || '').trim();
        if (!displayName) continue;

        let tier = tierByCode.get(code);
        if (!tier) {
          const usedCodes = new Set([...tierByCode.keys()]);
          const meta = tierMetaFromLabel(String(row.tierCode || row.code || '').trim(), usedCodes);
          tier = await TournamentTier.create({
            tournamentId: tournament.id,
            code: meta.code,
            label: meta.label,
            kind: meta.kind,
            rankWeight: meta.rankWeight,
            sortOrder: meta.sortOrder,
          });
          tierByCode.set(meta.code.toUpperCase(), tier);
        }

        const pos = positionCounters.get(code) ?? 0;
        positionCounters.set(code, pos + 1);

        let playerId = row.playerId ?? null;
        let creatorId = row.creatorId ?? null;
        const effectiveMode = resolveEffectiveRowMode(
          row.rowMode ?? null,
          tournament.placementMode,
        );
        if (autoLink && effectiveMode === 'profile' && playerId == null && creatorId == null) {
          playerId = lookupNameId(nameMap, displayName);
        }

        if (effectiveMode !== 'profile') {
          playerId = null;
          creatorId = null;
        } else if (creatorId != null) {
          playerId = null;
        } else {
          creatorId = null;
        }

        const placementPayload = {
          tournamentId: tournament.id,
          tierId: row.tierId ?? tier.id,
          displayName,
          playerId,
          creatorId,
          withdrew,
          isPending: Boolean(row.isPending) || displayName === '?',
          teamKey: row.teamKey ?? null,
          teamName: row.teamName ?? null,
          positionInTier: Number.isFinite(row.positionInTier)
            ? row.positionInTier
            : pos,
          rowMode: row.rowMode ?? null,
          levelId: row.levelId ?? null,
          creditedCreatorIds: normalizeCreditedCreatorIds(row.creditedCreatorIds),
        };

        let placement: TournamentPlacement;
        if (row.id) {
          const existing = await TournamentPlacement.findOne({
            where: {id: row.id, tournamentId: tournament.id},
          });
          if (existing) {
            await existing.update(placementPayload);
            placement = existing;
          } else {
            placement = await TournamentPlacement.create(placementPayload);
          }
        } else {
          placement = await TournamentPlacement.create(placementPayload);
        }
      }

      // Level-mode placements need creator credits from LevelCredit; profile mode
      // needs player/creator credits. ensureProfileCredit alone skips level mode.
      await creditService.applySync(tournament.id);

      const full = await TournamentPlacement.findAll({
        where: {tournamentId: tournament.id},
        include: placementDetailInclude,
        order: [
          [{model: TournamentTier, as: 'tier'}, 'rankWeight', 'ASC'],
          ['positionInTier', 'ASC'],
        ],
      });
      return res.json(full);
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to update placements', {
        logLabel: 'Upsert placements failed:',
      });
    }
  },
);

router.post(
  '/:id([0-9]{1,20})/credits/sync/preview',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const tournamentId = parseInt(req.params.id, 10);
      const tournament = await Tournament.findByPk(tournamentId);
      if (!tournament) return res.status(404).json({error: 'Tournament not found'});

      const placementIds = Array.isArray(req.body.placementIds)
        ? parseOrderedIds(req.body.placementIds)
        : undefined;
      const preview = await creditService.previewSync(tournamentId, placementIds);
      return res.json(preview);
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to preview credit sync', {
        logLabel: 'Preview credit sync failed:',
      });
    }
  },
);

router.post(
  '/:id([0-9]{1,20})/credits/sync',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const tournamentId = parseInt(req.params.id, 10);
      const tournament = await Tournament.findByPk(tournamentId);
      if (!tournament) return res.status(404).json({error: 'Tournament not found'});

      const placementIds = Array.isArray(req.body.placementIds)
        ? parseOrderedIds(req.body.placementIds)
        : undefined;
      const result = await creditService.applySync(tournamentId, placementIds);
      return res.json(result);
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to sync credits', {
        logLabel: 'Apply credit sync failed:',
      });
    }
  },
);

router.post(
  '/:id([0-9]{1,20})/sync-credits',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const tournamentId = parseInt(req.params.id, 10);
      const tournament = await Tournament.findByPk(tournamentId);
      if (!tournament) return res.status(404).json({error: 'Tournament not found'});

      const placementIds = Array.isArray(req.body.placementIds)
        ? parseOrderedIds(req.body.placementIds)
        : undefined;
      const dryRun = req.body.dryRun === true || req.body.dryRun === 'true';

      if (dryRun) {
        const preview = await creditService.previewSync(tournamentId, placementIds);
        return res.json(preview);
      }
      const result = await creditService.applySync(tournamentId, placementIds);
      return res.json(result);
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to sync credits', {
        logLabel: 'Sync credits failed:',
      });
    }
  },
);

router.post(
  '/placements/:placementId([0-9]{1,20})/sync-credits',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const placementId = parseInt(req.params.placementId, 10);
      const placement = await TournamentPlacement.findByPk(placementId);
      if (!placement) return res.status(404).json({error: 'Placement not found'});

      const dryRun = req.body.dryRun === true || req.body.dryRun === 'true';
      if (dryRun) {
        const preview = await creditService.previewSync(placement.tournamentId, [placementId]);
        return res.json(preview);
      }
      const result = await creditService.applySync(placement.tournamentId, [placementId]);
      return res.json(result);
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to sync placement credits', {
        logLabel: 'Sync placement credits failed:',
      });
    }
  },
);

router.get(
  '/nominee-candidates/:levelId([0-9]{1,20})',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const levelId = parseInt(req.params.levelId, 10);
      const roleFilter = normalizeCreditRoleFilter(req.query.roles);
      const roles = roleFilter.filter(
        (r): r is CreditRole => r === CreditRole.CHARTER || r === CreditRole.VFXER,
      );

      const candidates = await loadNomineeCandidates(levelId, roles);
      return res.json(candidates);
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to list nominee candidates', {
        logLabel: 'List nominee candidates failed:',
      });
    }
  },
);

router.post(
  '/:id([0-9]{1,20})/pack-import/diff',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const tournamentId = parseInt(req.params.id, 10);
      const packRef = String(req.body.packRef || '').trim();
      if (!packRef) return res.status(400).json({error: 'packRef is required'});
      const diff = await packImportService.computeDiff(tournamentId, packRef);
      return res.json(diff);
    } catch (error: any) {
      if (error?.code === 404) return res.status(404).json({error: error.message});
      return respondMysqlClientError(res, error, 'Failed to compute pack diff', {
        logLabel: 'Pack import diff failed:',
      });
    }
  },
);

router.post(
  '/:id([0-9]{1,20})/pack-import',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const tournamentId = parseInt(req.params.id, 10);
      const packRef = String(req.body.packRef || '').trim();
      if (!packRef) return res.status(400).json({error: 'packRef is required'});
      const result = await packImportService.applyImport(tournamentId, packRef, {
        acceptAdds: true,
        acceptRemoves: req.body.acceptRemoves === true,
        placementIdsToRemove: parseOrderedIds(req.body.placementIdsToRemove),
        syncCredits: req.body.syncCredits !== false,
      });
      return res.json(result);
    } catch (error: any) {
      if (error?.code === 404) return res.status(404).json({error: error.message});
      return respondMysqlClientError(res, error, 'Failed to import pack', {
        logLabel: 'Pack import failed:',
      });
    }
  },
);

router.patch(
  '/placements/:placementId([0-9]{1,20})',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const placement = await TournamentPlacement.findByPk(req.params.placementId, {
        include: [{model: Tournament, as: 'tournament'}],
      });
      if (!placement) return res.status(404).json({error: 'Placement not found'});

      const updates: Record<string, unknown> = {};
      for (const field of [
        'displayName',
        'playerId',
        'creatorId',
        'withdrew',
        'isPending',
        'teamKey',
        'teamName',
        'positionInTier',
        'tierId',
      ] as const) {
        if (req.body[field] !== undefined) updates[field] = req.body[field];
      }

      await placement.update(updates);
      const tournament = (placement as any).tournament as Tournament | undefined;
      if (tournament) {
        await creditService.applySync(placement.tournamentId, [placement.id]);
      } else {
        await rewardService.syncEntitlementsForTournament(placement.tournamentId);
      }

      const full = await TournamentPlacement.findByPk(placement.id, {
        include: placementDetailInclude,
      });
      return res.json(full);
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to update placement', {
        logLabel: 'Patch placement failed:',
      });
    }
  },
);

// ── Unresolved names ────────────────────────────────────────────────

router.get(
  '/unresolved',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const where: Record<string, unknown> = {
        isPending: false,
        [Op.and]: [
          {playerId: null},
          {creatorId: null},
        ],
      };

      const placements = await TournamentPlacement.findAll({
        where,
        include: [
          {
            model: Tournament,
            as: 'tournament',
            required: true,
          },
          {model: TournamentTier, as: 'tier', required: true},
        ],
        order: [
          ['displayName', 'ASC'],
          ['id', 'ASC'],
        ],
        limit: Math.min(parseInt(String(req.query.limit || '500'), 10) || 500, 2000),
      });

      return res.json(placements);
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to list unresolved placements', {
        logLabel: 'List unresolved placements failed:',
      });
    }
  },
);

router.post(
  '/resolve-names',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const placementIds: number[] | null = Array.isArray(req.body.placementIds)
        ? req.body.placementIds.map(Number).filter(Number.isFinite)
        : null;

      const where: Record<string, unknown> = {
        isPending: false,
        playerId: null,
        creatorId: null,
      };
      if (placementIds?.length) where.id = {[Op.in]: placementIds};

      const placements = await TournamentPlacement.findAll({
        where,
        include: [
          {
            model: Tournament,
            as: 'tournament',
            required: true,
          },
        ],
      });

      let linked = 0;
      const stillUnresolved: string[] = [];
      const entitlementSyncTournamentIds = new Set<number>();

      for (const placement of placements) {
        const tournament = (placement as any).tournament as Tournament;
        const resolved = await resolvePlacementName(placement.displayName);
        if (resolved.playerId) {
          await placement.update({playerId: resolved.playerId, creatorId: null});
          await creditService.ensureProfileCredit(placement, tournament);
          linked += 1;
          entitlementSyncTournamentIds.add(tournament.id);
        } else {
          stillUnresolved.push(placement.displayName);
        }
      }

      for (const tournamentId of entitlementSyncTournamentIds) {
        await rewardService.syncEntitlementsForTournament(tournamentId);
      }

      return res.json({
        linked,
        stillUnresolved: [...new Set(stillUnresolved)],
      });
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to resolve names', {
        logLabel: 'Resolve names failed:',
      });
    }
  },
);

// ── Rewards ─────────────────────────────────────────────────────────

router.get(
  '/:id([0-9]{1,20})/rewards',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const rewards = await PlacementReward.findAll({
        where: {tournamentId: req.params.id},
        order: [
          ['priority', 'DESC'],
          ['id', 'ASC'],
        ],
      });
      return res.json(rewards);
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to list rewards', {
        logLabel: 'List rewards failed:',
      });
    }
  },
);

router.post(
  '/:id([0-9]{1,20})/rewards',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const tournament = await Tournament.findByPk(req.params.id);
      if (!tournament) return res.status(404).json({error: 'Tournament not found'});

      const label = String(req.body.label || '').trim();
      if (!label) return res.status(400).json({error: 'label is required'});

      const reward = await PlacementReward.create({
        tournamentId: tournament.id,
        seriesId: req.body.seriesId ?? null,
        tierId: req.body.tierId ?? null,
        maxRankWeight: req.body.maxRankWeight ?? null,
        requireNotWithdrew: req.body.requireNotWithdrew !== false,
        requireFinalResults: req.body.requireFinalResults !== false,
        rewardType: req.body.rewardType || 'avatar_frame',
        assetId: req.body.assetId ?? null,
        assetUrl: req.body.assetUrl ?? null,
        config: req.body.config ?? null,
        label,
        priority: Number(req.body.priority) || 0,
      });

      await rewardService.syncEntitlementsForReward(reward.id);
      return res.status(201).json(reward);
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to create reward', {
        logLabel: 'Create reward failed:',
      });
    }
  },
);

router.patch(
  '/rewards/:rewardId([0-9]{1,20})',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const reward = await PlacementReward.findByPk(req.params.rewardId);
      if (!reward) return res.status(404).json({error: 'Reward not found'});

      const fields = [
        'seriesId',
        'tierId',
        'maxRankWeight',
        'requireNotWithdrew',
        'requireFinalResults',
        'rewardType',
        'assetId',
        'assetUrl',
        'config',
        'label',
        'priority',
      ] as const;
      const updates: Record<string, unknown> = {};
      for (const field of fields) {
        if (req.body[field] !== undefined) updates[field] = req.body[field];
      }
      await reward.update(updates);
      await rewardService.syncEntitlementsForReward(reward.id);
      return res.json(reward);
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to update reward', {
        logLabel: 'Update reward failed:',
      });
    }
  },
);

router.delete(
  '/rewards/:rewardId([0-9]{1,20})',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const reward = await PlacementReward.findByPk(req.params.rewardId);
      if (!reward) return res.status(404).json({error: 'Reward not found'});
      const tournamentId = reward.tournamentId;
      await reward.destroy();
      if (tournamentId) {
        await rewardService.syncEntitlementsForTournament(tournamentId);
      }
      return res.json({success: true});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to delete reward', {
        logLabel: 'Delete reward failed:',
      });
    }
  },
);

router.post(
  '/rewards/:rewardId([0-9]{1,20})/asset',
  Auth.superAdmin(),
  upload.single('asset'),
  async (req: Request, res: Response) => {
    try {
      const reward = await PlacementReward.findByPk(req.params.rewardId);
      if (!reward) return res.status(404).json({error: 'Reward not found'});
      if (!req.file) return res.status(400).json({error: 'No file uploaded'});

      const result = await cdnService.uploadTournamentPlacementIcon(
        req.file.buffer,
        req.file.originalname,
      );
      const displayUrl =
        result.urls?.medium ?? result.urls?.original ?? result.urls?.small ?? null;
      if (!displayUrl) {
        return res.status(500).json({error: 'CDN did not return asset URL'});
      }

      const oldId = reward.assetId;
      await reward.update({
        assetId: result.fileId,
        assetUrl: displayUrl,
      });

      if (oldId && oldId !== result.fileId) {
        await deleteCdnAssetIfExists(oldId);
      }

      await rewardService.syncEntitlementsForReward(reward.id);
      return res.json(reward);
    } catch (error) {
      if (error instanceof CdnError) {
        return res.status(400).json({
          error: error.message,
          code: error.code,
        });
      }
      return respondMysqlClientError(res, error, 'Failed to upload reward asset', {
        logLabel: 'Upload reward asset failed:',
      });
    }
  },
);

router.post(
  '/:id([0-9]{1,20})/sync-entitlements',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const result = await rewardService.syncEntitlementsForTournament(
        parseInt(req.params.id, 10),
      );
      return res.json(result);
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to sync entitlements', {
        logLabel: 'Sync entitlements failed:',
      });
    }
  },
);

// ── CSV import ──────────────────────────────────────────────────────

router.post(
  '/import',
  Auth.superAdmin(),
  upload.single('file'),
  async (req: Request, res: Response) => {
    try {
      let csvText = '';
      if (req.file?.buffer) {
        csvText = req.file.buffer.toString('utf8');
      } else if (typeof req.body.csv === 'string') {
        csvText = req.body.csv;
      } else {
        return res.status(400).json({error: 'CSV file or csv body required'});
      }

      const report = await csvImportService.importCsv(csvText, {
        dryRun: req.body.dryRun === 'true' || req.body.dryRun === true,
        replacePlacements:
          req.body.replacePlacements !== 'false' &&
          req.body.replacePlacements !== false,
      });
      return res.json(report);
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to import CSV', {
        logLabel: 'CSV import failed:',
      });
    }
  },
);

export default router;
