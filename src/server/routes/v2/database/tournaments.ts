import {Router, Request, Response} from 'express';
import {Op} from 'sequelize';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {idParamSpec, errorResponseSchema, standardErrorResponses404500} from '@/server/schemas/v2/database/index.js';
import {respondMysqlClientError} from '@/misc/utils/db/mysqlClientError.js';
import {getSequelizeForModelGroup} from '@/config/db.js';
import TournamentSeries from '@/models/tournaments/TournamentSeries.js';
import Tournament from '@/models/tournaments/Tournament.js';
import TournamentTier from '@/models/tournaments/TournamentTier.js';
import TournamentPlacement from '@/models/tournaments/TournamentPlacement.js';
import TournamentPlacementCredit from '@/models/tournaments/TournamentPlacementCredit.js';
import PlacementReward from '@/models/tournaments/PlacementReward.js';
import Player from '@/models/players/Player.js';
import Creator from '@/models/credits/Creator.js';
import Level from '@/models/levels/Level.js';
import User from '@/models/auth/User.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import {normalizeOwnerUserIds} from '@/server/services/tournaments/tournamentOwnership.js';
import {
  canEditPublicTournament,
  canViewTournamentDetail,
  isPubliclyListedTournament,
  parseHashIdSearch,
  parsePublicTournamentStatus,
  serializePublicSeries,
  serializePublicTournamentCard,
  serializePublicTournamentDetail,
} from '@/server/services/tournaments/serializePublicTournament.js';
import {UNSERIESED_SORT_WEIGHT} from '@/server/services/tournaments/placementModeUtils.js';

const router: Router = Router();
const elasticsearchService = ElasticsearchService.getInstance();

const publicListWhere = (status?: string | null) => {
  const where: Record<string, unknown> = {
    isHidden: false,
    status: {[Op.ne]: 'draft'},
  };
  if (status) where.status = status;
  return where;
};

const placementPublicInclude = [
  {model: TournamentTier, as: 'tier'},
  {
    model: Player,
    as: 'player',
    required: false,
    attributes: ['id', 'name', 'pfp'],
    include: [
      {
        model: User,
        as: 'user',
        required: false,
        attributes: ['id', 'avatarUrl'],
      },
    ],
  },
  {
    model: Creator,
    as: 'creator',
    required: false,
    attributes: ['id', 'name'],
    include: [
      {
        model: User,
        as: 'user',
        required: false,
        attributes: ['id', 'avatarUrl'],
      },
    ],
  },
  {
    model: Level,
    as: 'level',
    required: false,
    attributes: ['id', 'song', 'artist', 'diffId'],
  },
  {
    model: TournamentPlacementCredit,
    as: 'credits',
    required: false,
    include: [
      {
        model: Player,
        as: 'player',
        required: false,
        attributes: ['id', 'name', 'pfp'],
      },
      {
        model: Creator,
        as: 'creator',
        required: false,
        attributes: ['id', 'name'],
      },
    ],
  },
];

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

async function placementCountMap(tournamentIds: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  if (!tournamentIds.length) return map;
  const sequelize = getSequelizeForModelGroup('tournaments');
  const rows = await TournamentPlacement.findAll({
    attributes: ['tournamentId', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
    where: {tournamentId: {[Op.in]: tournamentIds}},
    group: ['tournamentId'],
    raw: true,
  });
  for (const row of rows as unknown as Array<{tournamentId: number; count: string | number}>) {
    map.set(Number(row.tournamentId), Number(row.count) || 0);
  }
  return map;
}

async function hydratePublicCards(ids: number[]) {
  if (!ids.length) return [];
  const tournaments = await Tournament.findAll({
    where: {
      id: {[Op.in]: ids},
      ...publicListWhere(),
    },
    include: [{model: TournamentSeries, as: 'series', required: false}],
  });
  const byId = new Map(tournaments.map(item => [item.id, item]));
  const counts = await placementCountMap(ids);
  return ids
    .map(id => byId.get(id))
    .filter((item): item is Tournament => Boolean(item))
    .map(item => serializePublicTournamentCard(item, counts.get(item.id) ?? 0))
    .filter(Boolean);
}

router.get(
  '/',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'listPublicTournaments',
    summary: 'List public tournaments',
    description:
      'Public catalog of non-hidden, non-draft tournaments. Empty query uses MySQL; search uses Elasticsearch then hydrates cards.',
    tags: ['Database', 'Tournaments'],
    query: {
      search: {schema: {type: 'string'}},
      status: {schema: {type: 'string'}},
    },
    responses: {200: {description: 'Public tournament cards'}, 500: {schema: errorResponseSchema}},
  }),
  async (req: Request, res: Response) => {
    try {
      const search = String(req.query.search || '').trim();
      const status = parsePublicTournamentStatus(req.query.status);
      const sequelize = getSequelizeForModelGroup('tournaments');

      if (search) {
        const hashId = parseHashIdSearch(search);
        let ids: number[] = [];
        if (hashId) {
          ids = [hashId];
        } else {
          const result = await elasticsearchService.searchTournaments({
            q: search,
            status: status ?? undefined,
          });
          ids = result.ids;
        }
        let cards = await hydratePublicCards(ids);
        if (status) {
          cards = cards.filter(card => card && card.status === status);
        }
        return res.json(cards);
      }

      const tournaments = await Tournament.findAll({
        where: publicListWhere(status),
        include: [{model: TournamentSeries, as: 'series', required: false}],
        order: [
          [sequelize.literal(`COALESCE(\`series\`.\`sortWeight\`, ${UNSERIESED_SORT_WEIGHT})`), 'ASC'],
          ['sortWeight', 'ASC'],
          ['sortYear', 'DESC'],
          ['shortName', 'ASC'],
        ],
      });
      const ids = tournaments.map(item => item.id);
      const counts = await placementCountMap(ids);
      return res.json(
        tournaments
          .map(item => serializePublicTournamentCard(item, counts.get(item.id) ?? 0))
          .filter(Boolean),
      );
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to list tournaments', {
        logLabel: 'List public tournaments failed:',
      });
    }
  },
);

router.get(
  '/series',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'listPublicTournamentSeries',
    summary: 'List tournament series',
    tags: ['Database', 'Tournaments'],
    responses: {200: {description: 'Series list'}, 500: {schema: errorResponseSchema}},
  }),
  async (_req: Request, res: Response) => {
    try {
      const series = await TournamentSeries.findAll({order: [['sortWeight', 'ASC']]});
      return res.json(series.map(item => serializePublicSeries(item)).filter(Boolean));
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to list tournament series', {
        logLabel: 'List public tournament series failed:',
      });
    }
  },
);

router.get(
  '/:id([0-9]{1,20})',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'getPublicTournament',
    summary: 'Get public tournament',
    description:
      'Full public tournament payload. Hidden and draft events 404 unless the caller is a super-admin or owner.',
    tags: ['Database', 'Tournaments'],
    security: ['bearerAuth'],
    params: {id: idParamSpec},
    responses: {200: {description: 'Tournament detail'}, ...standardErrorResponses404500},
  }),
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
            include: placementPublicInclude,
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
      if (!canViewTournamentDetail(tournament, req.user)) {
        return res.status(404).json({error: 'Tournament not found'});
      }
      const owners = await loadTournamentOwners(tournament.ownerUserIds);
      return res.json(
        serializePublicTournamentDetail(tournament, {
          owners,
          canEdit: canEditPublicTournament(tournament, req.user),
        }),
      );
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to get tournament', {
        logLabel: 'Get public tournament failed:',
      });
    }
  },
);

export default router;
