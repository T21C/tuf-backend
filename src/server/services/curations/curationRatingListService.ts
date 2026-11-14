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
import {searchCurationQueueLevelIds} from '@/server/services/elasticsearch/search/levels/levelSearch.js';
import {fetchLevelsByIdsFromElasticsearch} from '@/server/services/elasticsearch/search/levels/fetchLevelsByIdsFromElasticsearch.js';
import {pruneLevelForRatingList} from '@/server/services/elasticsearch/search/levels/ratingReferencedLevelSerialize.js';
import {normalizeMiscTypeIds} from '@/misc/utils/data/curationRatingPicks.js';
import {
  curationDiscordVoteWhereSql,
  isCurationDiscordVoteCard,
  type CurationFlowId,
} from '@/misc/utils/data/curationFlow.js';
import {
  parseCurationQueueCommaIds,
  type CurationRatingListQuery,
} from '@/misc/utils/data/curationRatingListQuery.js';

export {
  CURATION_RATING_LIST_PAGE_SIZE,
  parseCurationRatingListQuery,
} from '@/misc/utils/data/curationRatingListQuery.js';
export type {
  CurationRatingListOrder,
  CurationRatingListQuery,
  CurationRatingListSort,
  CurationVoteFilter,
  ShowHideOnly,
} from '@/misc/utils/data/curationRatingListQuery.js';

const DETAIL_COUNT_SQL = `(
  SELECT COUNT(*) FROM curation_rating_details AS crd
  WHERE crd.curationRatingId = CurationRating.id
)`;

const completeLevelIncludes = [
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
  {
    model: Curation,
    as: 'curations',
    required: false,
    include: [
      {
        model: CurationType,
        as: 'types',
        attributes: ['id', 'name', 'icon'],
        through: {attributes: []},
        required: false,
      },
    ],
  },
];

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

function toCurationRatingRow(
  rating: CurationRating,
  level: Record<string, unknown>,
  details: CurationRatingDetail[],
  complete: boolean,
): Record<string, unknown> {
  const isDiscordVote = isCurationDiscordVoteCard({
    curationRerateNum: typeof level.curationRerateNum === 'string' ? level.curationRerateNum : null,
    discordMessageUrl: rating.discordMessageUrl,
    discordThreadClosed: rating.discordThreadClosed,
  });
  return {
    id: rating.id,
    levelId: rating.levelId,
    confirmedAt: rating.confirmedAt,
    settledByUserId: rating.settledByUserId,
    discordMessageUrl: rating.discordMessageUrl,
    discordPostError: rating.discordPostError,
    discordThreadClosed: rating.discordThreadClosed,
    isDiscordVote,
    createdAt: rating.createdAt,
    updatedAt: rating.updatedAt,
    level,
    details: details.map((detail) => serializeDetail(detail, complete)),
  };
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
  return toCurationRatingRow(rating, level, rating.details || [], complete);
}

async function resolveSearchLevelIds(
  textQuery: string,
  flow: CurationFlowId | null,
): Promise<number[] | 'empty' | null> {
  if (!textQuery) return null;
  const commaIds = parseCurationQueueCommaIds(textQuery);
  if (commaIds) {
    return commaIds.length > 0 ? commaIds : 'empty';
  }
  const matched = await searchCurationQueueLevelIds(textQuery, {flow});
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

async function hydrateCurationRatingListRows(
  ratings: CurationRating[],
): Promise<Record<string, unknown>[]> {
  if (ratings.length === 0) return [];

  const levelIds = [...new Set(ratings.map((row) => row.levelId).filter((id) => id > 0))];
  const esLevels = await fetchLevelsByIdsFromElasticsearch(levelIds);
  const levelsById = new Map<number, Record<string, unknown>>();

  for (const [id, level] of esLevels) {
    const pruned = pruneLevelForRatingList(level);
    if (pruned) levelsById.set(id, pruned);
  }

  const missingIds = levelIds.filter((id) => !levelsById.has(id));
  if (missingIds.length > 0) {
    const mysqlLevels = await Level.findAll({
      where: {
        id: missingIds,
        isDeleted: false,
        isHidden: false,
        toCuration: true,
      },
      attributes: [
        'id',
        'song',
        'artist',
        'creator',
        'diffId',
        'clears',
        'rerateNum',
        'rerateReason',
        'notes',
        'suffix',
        'songId',
        'team',
        'videoLink',
        'dlLink',
        'workshopLink',
        'toRate',
        'toCuration',
        'curationFlow',
        'curationRerateNum',
        'curationRerateReason',
      ],
      include: [
        {
          association: 'levelCredits',
          required: false,
          attributes: ['role', 'sortOrder', 'id'],
          include: [{association: 'creator', attributes: ['id', 'name'], required: false}],
        },
        {
          association: 'songObject',
          required: false,
          attributes: ['id', 'name'],
        },
        {
          association: 'teamObject',
          required: false,
          attributes: ['id', 'name'],
        },
        {
          association: 'curations',
          required: false,
          include: [
            {
              association: 'types',
              attributes: ['id'],
              through: {attributes: []},
              required: false,
            },
          ],
        },
      ],
    });
    for (const level of mysqlLevels) {
      const pruned = pruneLevelForRatingList(
        level.toJSON() as unknown as Record<string, unknown>,
      );
      if (pruned && typeof pruned.id === 'number') {
        levelsById.set(pruned.id, pruned);
      }
    }
  }

  const ratingIds = ratings.map((row) => row.id);
  const details = await CurationRatingDetail.findAll({
    where: {curationRatingId: ratingIds},
    attributes: ['id', 'curationRatingId', 'userId', 'chartTypeId', 'vfxTypeId', 'miscTypeIds'],
    include: [
      {
        model: User,
        as: 'user',
        attributes: ['id', 'username'],
        required: false,
      },
    ],
  });
  const detailsByRatingId = new Map<number, CurationRatingDetail[]>();
  for (const detail of details) {
    const list = detailsByRatingId.get(detail.curationRatingId) || [];
    list.push(detail);
    detailsByRatingId.set(detail.curationRatingId, list);
  }

  const rows: Record<string, unknown>[] = [];
  for (const rating of ratings) {
    const level = levelsById.get(rating.levelId);
    if (!level) continue;
    rows.push(
      toCurationRatingRow(
        rating,
        level,
        detailsByRatingId.get(rating.id) || [],
        false,
      ),
    );
  }
  return rows;
}

export async function getCurationRatingListPage(params: CurationRatingListQuery) {
  const searchIds = await resolveSearchLevelIds(params.query, params.flow);
  if (searchIds === 'empty') {
    return {results: [], total: 0, offset: params.offset, limit: params.limit, hasMore: false};
  }

  const ratingWhere: Record<string, unknown> = {confirmedAt: null};
  if (searchIds) {
    ratingWhere.levelId = {[Op.in]: searchIds};
  }

  if (params.userId && params.myRated !== 'show') {
    const ratedIdsSql = `(SELECT curationRatingId FROM curation_rating_details WHERE userId = ${CurationRating.sequelize!.escape(params.userId)})`;
    ratingWhere.id = {
      [params.myRated === 'only' ? Op.in : Op.notIn]: literal(ratedIdsSql),
    };
  }

  const levelWhere: Record<string, unknown> = {
    toCuration: true,
    isDeleted: false,
    isHidden: false,
    ...(params.flow ? {curationFlow: params.flow} : {}),
  };

  const whereAnd: object[] = [];
  if (params.vote !== 'include') {
    whereAnd.push(literal(curationDiscordVoteWhereSql(params.vote)));
  }

  const where: WhereOptions = whereAnd.length
    ? {...ratingWhere, [Op.and]: whereAnd}
    : ratingWhere;

  const levelInclude = {
    model: Level,
    as: 'level',
    required: true,
    attributes: ['id', 'toCuration', 'curationFlow', 'curationRerateNum'],
    where: levelWhere,
  };

  const order =
    params.sort === 'ratings'
      ? [[literal(DETAIL_COUNT_SQL), params.order]]
      : params.sort === 'id'
        ? [['levelId', params.order]]
        : [['updatedAt', params.order]];

  const total = await CurationRating.count({
    where,
    include: [
      {
        ...levelInclude,
        attributes: [],
      },
    ],
    distinct: true,
    col: 'id',
  });

  if (total === 0) {
    return {results: [], total: 0, offset: params.offset, limit: params.limit, hasMore: false};
  }

  const rows = await CurationRating.findAll({
    where,
    include: [levelInclude],
    offset: params.offset,
    limit: params.limit,
    order: order as any,
    subQuery: false,
  });

  const results = (await hydrateCurationRatingListRows(rows)).filter((row) => {
    if (params.vote === 'include') return true;
    const isVote = row.isDiscordVote === true;
    return params.vote === 'only' ? isVote : !isVote;
  });

  return {
    results,
    total,
    offset: params.offset,
    limit: params.limit,
    hasMore: params.offset + rows.length < total,
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
