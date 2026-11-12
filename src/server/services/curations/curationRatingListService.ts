import {Op, literal, type WhereOptions} from 'sequelize';
import CurationRating from '@/models/curations/CurationRating.js';
import CurationRatingDetail from '@/models/curations/CurationRatingDetail.js';
import Level from '@/models/levels/Level.js';
import User from '@/models/auth/User.js';
import Difficulty from '@/models/levels/Difficulty.js';
import Team from '@/models/credits/Team.js';
import {TeamAlias} from '@/models/credits/TeamAlias.js';
import Creator from '@/models/credits/Creator.js';
import {CreatorAlias} from '@/models/credits/CreatorAlias.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import LevelAlias from '@/models/levels/LevelAlias.js';
import Curation from '@/models/curations/Curation.js';
import CurationType from '@/models/curations/CurationType.js';
import Song from '@/models/songs/Song.js';
import SongAlias from '@/models/songs/SongAlias.js';
import SongCredit from '@/models/songs/SongCredit.js';
import Artist from '@/models/artists/Artist.js';
import ArtistAlias from '@/models/artists/ArtistAlias.js';
import {searchLevelIdsInSet} from '@/server/services/elasticsearch/search/levels/levelSearch.js';
import {pruneLevelForRatingList} from '@/server/services/elasticsearch/search/levels/ratingReferencedLevelSerialize.js';
import {normalizeMiscTypeIds} from '@/misc/utils/data/curationRatingPicks.js';

export const CURATION_RATING_LIST_PAGE_SIZE = 30;

export type CurationRatingListSort = 'id' | 'ratings' | 'updatedAt';
export type CurationRatingListOrder = 'ASC' | 'DESC';
export type ShowHideOnly = 'show' | 'hide' | 'only';

export interface CurationRatingListQuery {
  offset: number;
  limit: number;
  query: string;
  sort: CurationRatingListSort;
  order: CurationRatingListOrder;
  myRated: ShowHideOnly;
  userId: string | null;
}

const DETAIL_COUNT_SQL = `(
  SELECT COUNT(*) FROM curation_rating_details AS crd
  WHERE crd.curationRatingId = CurationRating.id
)`;

const levelListIncludes = [
  {
    model: LevelAlias,
    as: 'aliases',
    attributes: ['field', 'alias'],
    required: false,
  },
  {
    model: Song,
    as: 'songObject',
    attributes: ['id', 'name'],
    required: false,
    include: [
      {
        model: SongAlias,
        as: 'aliases',
        attributes: ['alias'],
        required: false,
      },
      {
        model: SongCredit,
        as: 'credits',
        attributes: ['role'],
        required: false,
        include: [
          {
            model: Artist,
            as: 'artist',
            attributes: ['id', 'name'],
            required: false,
            include: [
              {
                model: ArtistAlias,
                as: 'aliases',
                attributes: ['alias'],
                required: false,
              },
            ],
          },
        ],
      },
    ],
  },
  {
    model: Team,
    as: 'teamObject',
    attributes: ['name'],
    required: false,
    include: [
      {
        model: TeamAlias,
        as: 'teamAliases',
        attributes: ['name'],
        required: false,
      },
    ],
  },
  {
    model: LevelCredit,
    as: 'levelCredits',
    required: false,
    attributes: ['id', 'role', 'sortOrder'],
    include: [
      {
        model: Creator,
        as: 'creator',
        attributes: ['name', 'id'],
        include: [
          {
            model: CreatorAlias,
            as: 'creatorAliases',
            attributes: ['name'],
            required: false,
          },
        ],
      },
    ],
  },
  {model: Difficulty, as: 'difficulty', required: false},
];

const completeLevelIncludes = [
  ...levelListIncludes,
  {
    model: Curation,
    as: 'curations',
    required: false,
    include: [
      {
        model: CurationType,
        as: 'types',
        attributes: ['id'],
        through: {attributes: []},
        required: false,
      },
    ],
  },
];

function parseSort(value: unknown): CurationRatingListSort {
  const text = String(value || '').trim();
  if (text === 'id' || text === 'updatedAt' || text === 'ratings') return text;
  return 'ratings';
}

function parseOrder(value: unknown): CurationRatingListOrder {
  return String(value || '').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
}

function parseMyRated(value: unknown): ShowHideOnly {
  const text = String(value || '').trim();
  if (text === 'hide' || text === 'only') return text;
  return 'show';
}

export function parseCurationRatingListQuery(
  query: Record<string, unknown>,
  userId: string | null,
): CurationRatingListQuery {
  const offset = Math.max(0, Math.floor(Number(query.offset) || 0));
  const limitRaw = Math.floor(Number(query.limit) || CURATION_RATING_LIST_PAGE_SIZE);
  const limit = Math.min(100, Math.max(1, limitRaw));
  return {
    offset,
    limit,
    query: typeof query.query === 'string' ? query.query.trim() : '',
    sort: parseSort(query.sort),
    order: parseOrder(query.order),
    myRated: parseMyRated(query.myRated),
    userId,
  };
}

function serializeDetail(detail: CurationRatingDetail, complete: boolean) {
  const miscTypeIds = normalizeMiscTypeIds(detail.miscTypeIds);
  const base: Record<string, unknown> = {
    id: detail.id,
    userId: detail.userId,
    chartTypeId: detail.chartTypeId,
    vfxTypeId: detail.vfxTypeId,
    miscTypeIds,
  };
  if (complete) {
    base.comment = detail.comment ?? '';
    base.createdAt = detail.createdAt;
    base.updatedAt = detail.updatedAt;
    if (detail.user) {
      base.user = {
        id: detail.user.id,
        username: detail.user.username,
        nickname: detail.user.nickname,
        avatarUrl: detail.user.avatarUrl,
      };
    }
  } else {
    base.username = detail.user?.username ?? null;
  }
  return base;
}

function serializeRow(
  rating: CurationRating,
  complete: boolean,
): Record<string, unknown> | null {
  const levelRaw = rating.level
    ? (rating.level.toJSON() as unknown as Record<string, unknown>)
    : null;
  const level = pruneLevelForRatingList(levelRaw);
  if (!level) return null;
  return {
    id: rating.id,
    levelId: rating.levelId,
    confirmedAt: rating.confirmedAt,
    settledByUserId: rating.settledByUserId,
    createdAt: rating.createdAt,
    updatedAt: rating.updatedAt,
    level,
    details: (rating.details || []).map((detail) => serializeDetail(detail, complete)),
  };
}

async function resolveSearchLevelIds(textQuery: string): Promise<number[] | 'empty' | null> {
  if (!textQuery) return null;
  const pending = await CurationRating.findAll({
    where: {confirmedAt: null},
    attributes: ['levelId'],
    include: [
      {
        model: Level,
        as: 'level',
        required: true,
        attributes: [],
        where: {toCuration: true, isDeleted: false, isHidden: false},
      },
    ],
  });
  const pendingIds = [...new Set(pending.map((row) => row.levelId))];
  if (pendingIds.length === 0) return 'empty';
  const matched = await searchLevelIdsInSet(textQuery, pendingIds, {requireToRate: false});
  if (matched.length === 0) return 'empty';
  return matched;
}

function detailInclude(complete: boolean) {
  return {
    model: CurationRatingDetail,
    as: 'details',
    required: false,
    include: [
      {
        model: User,
        as: 'user',
        attributes: complete
          ? ['id', 'username', 'nickname', 'avatarUrl']
          : ['id', 'username'],
        required: false,
      },
    ],
  };
}

export async function getCurationRatingListPage(params: CurationRatingListQuery) {
  const searchIds = await resolveSearchLevelIds(params.query);
  if (searchIds === 'empty') {
    return {results: [], total: 0, offset: params.offset, limit: params.limit, hasMore: false};
  }

  const where: WhereOptions = {confirmedAt: null};
  const include: object[] = [
    {
      model: Level,
      as: 'level',
      required: true,
      where: {
        toCuration: true,
        isDeleted: false,
        isHidden: false,
        ...(searchIds ? {id: {[Op.in]: searchIds}} : {}),
      },
      include: levelListIncludes,
    },
    detailInclude(false),
  ];

  if (params.userId && params.myRated !== 'show') {
    const existsLiteral = literal(
      `EXISTS (SELECT 1 FROM curation_rating_details crd WHERE crd.curationRatingId = CurationRating.id AND crd.userId = ${CurationRating.sequelize!.escape(params.userId)})`,
    );
    Object.assign(where, {
      [Op.and]: [params.myRated === 'only' ? existsLiteral : {[Op.not]: existsLiteral}],
    });
  }

  const order =
    params.sort === 'ratings'
      ? [[literal(DETAIL_COUNT_SQL), params.order]]
      : params.sort === 'id'
        ? [[{model: Level, as: 'level'}, 'id', params.order]]
        : [['updatedAt', params.order]];

  const {rows, count} = await CurationRating.findAndCountAll({
    where,
    include,
    offset: params.offset,
    limit: params.limit,
    order: order as any,
    distinct: true,
    subQuery: false,
  });

  const results = rows
    .map((row) => serializeRow(row, false))
    .filter((row): row is Record<string, unknown> => row != null);

  return {
    results,
    total: count,
    offset: params.offset,
    limit: params.limit,
    hasMore: params.offset + results.length < count,
  };
}

async function loadCompleteCurationRating(where: Record<string, unknown>) {
  const rating = await CurationRating.findOne({
    where,
    include: [
      {
        model: Level,
        as: 'level',
        required: true,
        where: {isDeleted: false, isHidden: false},
        include: completeLevelIncludes,
      },
      detailInclude(true),
    ],
  });
  if (!rating) return null;
  if (rating.confirmedAt != null || rating.level?.toCuration === false) return null;
  return serializeRow(rating, true);
}

export async function buildCompleteCurationRatingById(id: number) {
  return loadCompleteCurationRating({id, confirmedAt: null});
}

export async function buildCompleteCurationRatingByLevelId(levelId: number) {
  return loadCompleteCurationRating({levelId, confirmedAt: null});
}
