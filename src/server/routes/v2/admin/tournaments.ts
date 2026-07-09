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
import {
  TIER_TEMPLATES,
  getTierTemplate,
  inferTierFromCode,
  parsePrizeCode,
} from '@/server/services/tournaments/tierTemplates.js';
import {
  buildNameLookupMaps,
  lookupNameId,
  resolvePlacementName,
} from '@/server/services/tournaments/PlacementNameResolver.js';
import {PlacementRewardService} from '@/server/services/tournaments/PlacementRewardService.js';
import {TournamentCsvImportService} from '@/server/services/tournaments/TournamentCsvImportService.js';
import cdnService, {CdnError} from '@/server/services/core/CdnService.js';
import type {TournamentTrack} from '@/models/tournaments/Tournament.js';
import {getSequelizeForModelGroup} from '@/config/db.js';


const router: Router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {fileSize: 10 * 1024 * 1024},
});

const rewardService = PlacementRewardService.getInstance();
const csvImportService = TournamentCsvImportService.getInstance();

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
];

function parseTrack(value: unknown): TournamentTrack | null {
  if (value === 'player' || value === 'creator') return value;
  return null;
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
      const series = await TournamentSeries.findAll({order: [['name', 'ASC']]});
      return res.json(series);
    } catch (error) {
      logger.error('List tournament series failed:', error);
      return res.status(500).json({error: 'Failed to list series'});
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
      if (error?.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).json({error: 'Series slug already exists'});
      }
      logger.error('Create tournament series failed:', error);
      return res.status(500).json({error: 'Failed to create series'});
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
      if (error?.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).json({error: 'Series slug already exists'});
      }
      logger.error('Update tournament series failed:', error);
      return res.status(500).json({error: 'Failed to update series'});
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
      logger.error('Delete tournament series failed:', error);
      return res.status(500).json({error: 'Failed to delete series'});
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
      const track = parseTrack(req.query.track);
      if (track) where.track = track;
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

      const tournaments = await Tournament.findAll({
        where,
        include: [
          {model: TournamentSeries, as: 'series', required: false},
          {model: TournamentTier, as: 'tiers', required: false},
        ],
        order: [
          ['sortYear', 'DESC'],
          ['shortName', 'ASC'],
        ],
      });

      const sequelize = getSequelizeForModelGroup('tournaments');
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
      logger.error('List tournaments failed:', error);
      return res.status(500).json({error: 'Failed to list tournaments'});
    }
  },
);

router.get(
  '/:id([0-9]{1,20})',
  Auth.superAdmin(),
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
      return res.json(tournament);
    } catch (error) {
      logger.error('Get tournament failed:', error);
      return res.status(500).json({error: 'Failed to get tournament'});
    }
  },
);

router.post(
  '/',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const track = parseTrack(req.body.track);
      const shortName = String(req.body.shortName || '').trim();
      if (!track || !shortName) {
        return res.status(400).json({error: 'shortName and track are required'});
      }

      const tournament = await Tournament.create({
        shortName,
        fullName: req.body.fullName ?? null,
        aka: req.body.aka ?? null,
        track,
        seriesId: req.body.seriesId ?? null,
        status: req.body.status ?? 'draft',
        isHidden: Boolean(req.body.isHidden),
        isResultsFinal: Boolean(req.body.isResultsFinal),
        youtubeUrl: req.body.youtubeUrl ?? null,
        packRef: req.body.packRef ?? null,
        notes: req.body.notes ?? null,
        externalUrl: req.body.externalUrl ?? null,
        organizers: Array.isArray(req.body.organizers) ? req.body.organizers : null,
        startsAt: req.body.startsAt ?? null,
        endsAt: req.body.endsAt ?? null,
        sortYear: req.body.sortYear ?? null,
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
      if (error?.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).json({error: 'Tournament shortName+track already exists'});
      }
      logger.error('Create tournament failed:', error);
      return res.status(500).json({error: 'Failed to create tournament'});
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
      if (req.body.track != null) {
        const track = parseTrack(req.body.track);
        if (!track) return res.status(400).json({error: 'Invalid track'});
        updates.track = track;
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
    } catch (error) {
      logger.error('Update tournament failed:', error);
      return res.status(500).json({error: 'Failed to update tournament'});
    }
  },
);

router.delete(
  '/:id([0-9]{1,20})',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const tournament = await Tournament.findByPk(req.params.id);
      if (!tournament) return res.status(404).json({error: 'Tournament not found'});
      await tournament.destroy();
      return res.json({success: true});
    } catch (error) {
      logger.error('Delete tournament failed:', error);
      return res.status(500).json({error: 'Failed to delete tournament'});
    }
  },
);

// ── Tournament & tier visual assets ───────────────────────────────

router.post(
  '/:id([0-9]{1,20})/icon',
  Auth.superAdmin(),
  upload.single('asset'),
  async (req: Request, res: Response) => {
    try {
      const tournament = await Tournament.findByPk(req.params.id);
      if (!tournament) return res.status(404).json({error: 'Tournament not found'});
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
      logger.error('Upload tournament icon failed:', error);
      return res.status(500).json({error: 'Failed to upload tournament icon'});
    }
  },
);

router.post(
  '/:id([0-9]{1,20})/card-background',
  Auth.superAdmin(),
  upload.single('asset'),
  async (req: Request, res: Response) => {
    try {
      const tournament = await Tournament.findByPk(req.params.id);
      if (!tournament) return res.status(404).json({error: 'Tournament not found'});
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
      logger.error('Upload tournament card background failed:', error);
      return res.status(500).json({error: 'Failed to upload card background'});
    }
  },
);

router.delete(
  '/:id([0-9]{1,20})/icon',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const tournament = await Tournament.findByPk(req.params.id);
      if (!tournament) return res.status(404).json({error: 'Tournament not found'});
      const oldId = tournament.iconAssetId;
      await tournament.update({iconAssetId: null, iconUrl: null});
      await deleteCdnAssetIfExists(oldId);
      return res.json(tournament);
    } catch (error) {
      logger.error('Remove tournament icon failed:', error);
      return res.status(500).json({error: 'Failed to remove tournament icon'});
    }
  },
);

router.delete(
  '/:id([0-9]{1,20})/card-background',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const tournament = await Tournament.findByPk(req.params.id);
      if (!tournament) return res.status(404).json({error: 'Tournament not found'});
      const oldId = tournament.cardBackgroundAssetId;
      await tournament.update({cardBackgroundAssetId: null, cardBackgroundUrl: null});
      await deleteCdnAssetIfExists(oldId);
      return res.json(tournament);
    } catch (error) {
      logger.error('Remove tournament card background failed:', error);
      return res.status(500).json({error: 'Failed to remove card background'});
    }
  },
);

router.post(
  '/:id([0-9]{1,20})/tiers/:tierId([0-9]{1,20})/icon',
  Auth.superAdmin(),
  upload.single('asset'),
  async (req: Request, res: Response) => {
    try {
      const tier = await TournamentTier.findOne({
        where: {id: req.params.tierId, tournamentId: req.params.id},
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
      logger.error('Upload tier icon failed:', error);
      return res.status(500).json({error: 'Failed to upload tier icon'});
    }
  },
);

router.post(
  '/:id([0-9]{1,20})/tiers/:tierId([0-9]{1,20})/card-background',
  Auth.superAdmin(),
  upload.single('asset'),
  async (req: Request, res: Response) => {
    try {
      const tier = await TournamentTier.findOne({
        where: {id: req.params.tierId, tournamentId: req.params.id},
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
      logger.error('Upload tier card background failed:', error);
      return res.status(500).json({error: 'Failed to upload tier card background'});
    }
  },
);

router.delete(
  '/:id([0-9]{1,20})/tiers/:tierId([0-9]{1,20})/icon',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const tier = await TournamentTier.findOne({
        where: {id: req.params.tierId, tournamentId: req.params.id},
      });
      if (!tier) return res.status(404).json({error: 'Tier not found'});
      const oldId = tier.iconAssetId;
      await tier.update({iconAssetId: null, iconUrl: null});
      await deleteCdnAssetIfExists(oldId);
      return res.json(tier);
    } catch (error) {
      logger.error('Remove tier icon failed:', error);
      return res.status(500).json({error: 'Failed to remove tier icon'});
    }
  },
);

router.delete(
  '/:id([0-9]{1,20})/tiers/:tierId([0-9]{1,20})/card-background',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const tier = await TournamentTier.findOne({
        where: {id: req.params.tierId, tournamentId: req.params.id},
      });
      if (!tier) return res.status(404).json({error: 'Tier not found'});
      const oldId = tier.cardBackgroundAssetId;
      await tier.update({cardBackgroundAssetId: null, cardBackgroundUrl: null});
      await deleteCdnAssetIfExists(oldId);
      return res.json(tier);
    } catch (error) {
      logger.error('Remove tier card background failed:', error);
      return res.status(500).json({error: 'Failed to remove tier card background'});
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

      for (let i = 0; i < tiers.length; i++) {
        const t = tiers[i];
        const code = String(t.code || '').trim().toUpperCase();
        if (!code) continue;
        const payload = {
          code,
          label: String(t.label || code).trim(),
          kind: t.kind || inferTierFromCode(code).kind,
          rankWeight: Number.isFinite(t.rankWeight)
            ? t.rankWeight
            : inferTierFromCode(code).rankWeight,
          isPodium: Boolean(t.isPodium),
          isShowcaseEligible: t.isShowcaseEligible !== false,
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
      logger.error('Replace tournament tiers failed:', error);
      return res.status(500).json({error: 'Failed to update tiers'});
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
      const autoLink = req.body.autoLink !== false;
      const nameMap = autoLink
        ? await buildNameLookupMaps(tournament.track)
        : new Map<string, number>();

      const tierByCode = new Map<string, TournamentTier>();
      const tiers = await TournamentTier.findAll({
        where: {tournamentId: tournament.id},
      });
      for (const t of tiers) tierByCode.set(t.code.toUpperCase(), t);

      await TournamentPlacement.destroy({where: {tournamentId: tournament.id}});

      const positionCounters = new Map<string, number>();
      const created = [];

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
          const inferred = inferTierFromCode(code);
          tier = await TournamentTier.create({
            tournamentId: tournament.id,
            ...inferred,
          });
          tierByCode.set(code, tier);
        }

        const pos = positionCounters.get(code) ?? 0;
        positionCounters.set(code, pos + 1);

        let playerId = row.playerId ?? null;
        let creatorId = row.creatorId ?? null;
        if (autoLink && playerId == null && creatorId == null) {
          const linked = lookupNameId(nameMap, displayName);
          if (tournament.track === 'player') playerId = linked;
          else creatorId = linked;
        }

        const placement = await TournamentPlacement.create({
          tournamentId: tournament.id,
          tierId: tier.id,
          displayName,
          playerId: tournament.track === 'player' ? playerId : null,
          creatorId: tournament.track === 'creator' ? creatorId : null,
          withdrew,
          isPending: Boolean(row.isPending) || displayName === '?',
          teamKey: row.teamKey ?? null,
          teamName: row.teamName ?? null,
          positionInTier: Number.isFinite(row.positionInTier)
            ? row.positionInTier
            : pos,
        });
        created.push(placement);
      }

      await rewardService.syncEntitlementsForTournament(tournament.id);

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
      logger.error('Replace placements failed:', error);
      return res.status(500).json({error: 'Failed to update placements'});
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
      await rewardService.syncEntitlementsForTournament(placement.tournamentId);

      const full = await TournamentPlacement.findByPk(placement.id, {
        include: placementDetailInclude,
      });
      return res.json(full);
    } catch (error) {
      logger.error('Patch placement failed:', error);
      return res.status(500).json({error: 'Failed to update placement'});
    }
  },
);

// ── Unresolved names ────────────────────────────────────────────────

router.get(
  '/unresolved',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const track = parseTrack(req.query.track);
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
            where: track ? {track} : undefined,
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
      logger.error('List unresolved placements failed:', error);
      return res.status(500).json({error: 'Failed to list unresolved placements'});
    }
  },
);

router.post(
  '/resolve-names',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const track = parseTrack(req.body.track);
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
            where: track ? {track} : undefined,
          },
        ],
      });

      let linked = 0;
      const stillUnresolved: string[] = [];

      for (const placement of placements) {
        const tournament = (placement as any).tournament as Tournament;
        const resolved = await resolvePlacementName(
          placement.displayName,
          tournament.track,
        );
        if (tournament.track === 'player' && resolved.playerId) {
          await placement.update({playerId: resolved.playerId});
          linked += 1;
          await rewardService.syncEntitlementsForTournament(tournament.id);
        } else if (tournament.track === 'creator' && resolved.creatorId) {
          await placement.update({creatorId: resolved.creatorId});
          linked += 1;
          await rewardService.syncEntitlementsForTournament(tournament.id);
        } else {
          stillUnresolved.push(placement.displayName);
        }
      }

      return res.json({
        linked,
        stillUnresolved: [...new Set(stillUnresolved)],
      });
    } catch (error) {
      logger.error('Resolve names failed:', error);
      return res.status(500).json({error: 'Failed to resolve names'});
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
      logger.error('List rewards failed:', error);
      return res.status(500).json({error: 'Failed to list rewards'});
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
        track: req.body.track ?? tournament.track,
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
      logger.error('Create reward failed:', error);
      return res.status(500).json({error: 'Failed to create reward'});
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
        'track',
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
      logger.error('Update reward failed:', error);
      return res.status(500).json({error: 'Failed to update reward'});
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
      logger.error('Delete reward failed:', error);
      return res.status(500).json({error: 'Failed to delete reward'});
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
      logger.error('Upload reward asset failed:', error);
      return res.status(500).json({error: 'Failed to upload reward asset'});
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
      logger.error('Sync entitlements failed:', error);
      return res.status(500).json({error: 'Failed to sync entitlements'});
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
      const track = parseTrack(req.body.track);
      if (!track) return res.status(400).json({error: 'track is required'});

      let csvText = '';
      if (req.file?.buffer) {
        csvText = req.file.buffer.toString('utf8');
      } else if (typeof req.body.csv === 'string') {
        csvText = req.body.csv;
      } else {
        return res.status(400).json({error: 'CSV file or csv body required'});
      }

      const report = await csvImportService.importCsv(csvText, track, {
        dryRun: req.body.dryRun === 'true' || req.body.dryRun === true,
        replacePlacements:
          req.body.replacePlacements !== 'false' &&
          req.body.replacePlacements !== false,
      });
      return res.json(report);
    } catch (error) {
      logger.error('CSV import failed:', error);
      return res.status(500).json({error: 'Failed to import CSV'});
    }
  },
);

export default router;
