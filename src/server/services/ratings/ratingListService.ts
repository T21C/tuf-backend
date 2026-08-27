import { createHash } from 'crypto';
import { Op, literal } from 'sequelize';
import * as Sentry from '@sentry/node';
import Rating from '@/models/levels/Rating.js';
import RatingDetail from '@/models/levels/RatingDetail.js';
import Level from '@/models/levels/Level.js';
import Difficulty from '@/models/levels/Difficulty.js';
import Pass from '@/models/passes/Pass.js';
import User from '@/models/auth/User.js';
import { searchLevelIdsInSet } from '@/server/services/elasticsearch/search/levels/levelSearch.js';
import { fetchLevelsByIdsFromElasticsearch } from '@/server/services/elasticsearch/search/levels/fetchLevelsByIdsFromElasticsearch.js';
import { pruneLevelForRatingList } from '@/server/services/elasticsearch/search/levels/ratingReferencedLevelSerialize.js';
import { getOrFetchCacheLayer } from '@/server/middleware/stackedCacheLayers.js';
import { logger } from '@/server/services/core/LoggerService.js';
import {
  isUniversalRatingProposal,
  lowDiffFilterForRequestBands,
  requestPguBand,
  type RequestPguBand,
} from '@/misc/utils/data/RatingUtils.js';
import { sseManager, SSE_SOURCES } from '@/misc/utils/server/sse.js';

export const RATING_LIST_PAGE_SIZE = 30;
export const RATING_LIST_CACHE_TTL_SEC = 300;
export const RATING_LIST_CACHE_TAG = 'admin:ratings';

export type RatingListSort = 'id' | 'ratings' | 'updatedAt';
export type RatingListOrder = 'ASC' | 'DESC';
export type ShowHideOnly = 'show' | 'hide' | 'only';
export type VoteFilter = 'only' | 'exclude' | undefined;

export interface RatingListQuery {
  offset: number;
  limit: number;
  query: string;
  sort: RatingListSort;
  order: RatingListOrder;
  lowDiff: ShowHideOnly;
  fourVote: ShowHideOnly;
  myRated: ShowHideOnly;
  zeroClears: boolean;
  rankReady: boolean;
  vote: VoteFilter;
  excludeUniversals: boolean;
  /** When set, keep only these request bands (P=lowDiff, U=universal proposal, G=rest). */
  includeRequestBands?: RequestPguBand[] | null;
  userId: string | null;
  levelIdsFilter: number[] | null;
}

export interface RatingListPage {
  results: Record<string, unknown>[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

const MANAGER_DETAIL_COUNT_SQL = `(
  SELECT COUNT(*) FROM rating_details AS rd
  WHERE rd.ratingId = Rating.id AND rd.isCommunityRating = 0
)`;

function managerDetailCountSql(excludeAutorater: boolean): string {
  const autoraterId = process.env.AUTORATER_UUID;
  const autoraterClause =
    excludeAutorater && autoraterId
      ? ` AND rd.userId != ${Rating.sequelize!.escape(autoraterId)}`
      : '';
  return `(
    SELECT COUNT(*) FROM rating_details AS rd
    WHERE rd.ratingId = Rating.id AND rd.isCommunityRating = 0${autoraterClause}
  )`;
}

/** Universals (U*, UQ*, Q*) first, then galactics (G*), then planetarys (P*). */
const RANK_READY_PGU_BAND_SQL = `CASE LEFT(UPPER(IFNULL((
  SELECT d.name FROM difficulties d WHERE d.id = Rating.averageDifficultyId
), '')), 1)
  WHEN 'U' THEN 0
  WHEN 'Q' THEN 0
  WHEN 'G' THEN 1
  WHEN 'P' THEN 2
  ELSE 3
END`;

function normalizeIncludeRequestBands(
  bands: RequestPguBand[] | null | undefined
): Set<RequestPguBand> | null {
  if (!bands) return null;
  return new Set(
    bands.filter(
      (band): band is RequestPguBand =>
        band === 'P' || band === 'G' || band === 'U'
    )
  );
}

export function parseCommaSeparatedIds(query: string): number[] | null {
  if (!query.includes(',')) return null;
  const parts = query.split(',').map((part) => part.trim());
  if (!parts.some((part) => part !== '')) return null;
  if (!parts.every((part) => part === '' || /^\d+$/.test(part))) return null;
  return parts.filter((part) => part !== '').map((part) => parseInt(part, 10));
}

/** Parse search-box string: vote / -vote tokens + remainder text or comma ids. */
export function parseRatingSearchBox(raw: string): {
  textQuery: string;
  vote: VoteFilter;
  levelIds: number[] | null;
} {
  let vote: VoteFilter;
  let text = (raw || '').trim();

  if (/^vote$/i.test(text)) {
    return { textQuery: '', vote: 'only', levelIds: null };
  }
  if (text.toLowerCase().includes('-vote')) {
    vote = 'exclude';
    text = text.replace(/-vote/gi, '').trim();
  }

  const levelIds = text ? parseCommaSeparatedIds(text) : null;
  if (levelIds) {
    return { textQuery: '', vote, levelIds };
  }
  return { textQuery: text, vote, levelIds: null };
}

function normalizeShowHideOnly(value: unknown): ShowHideOnly {
  const v = String(value || 'show');
  if (v === 'hide' || v === 'only') return v;
  return 'show';
}

/** `myRated` show/hide/only; legacy `hideRated=true` maps to hide. User-specific. */
function parseMyRated(
  reqQuery: Record<string, unknown>,
  userId?: string | null
): ShowHideOnly {
  if (!userId) return 'show';
  const raw = reqQuery.myRated ?? reqQuery.hideRated;
  if (raw === 'hide' || raw === 'only' || raw === 'show') return raw;
  if (raw === true || raw === 'true' || raw === '1') return 'hide';
  return 'show';
}

export function parseRatingListQuery(
  reqQuery: Record<string, unknown>,
  userId?: string | null
): RatingListQuery {
  const offset = Math.max(0, Number(reqQuery.offset) || 0);
  const limit = Math.min(
    RATING_LIST_PAGE_SIZE,
    Math.max(1, Number(reqQuery.limit) || RATING_LIST_PAGE_SIZE),
  );

  const sortRaw = String(reqQuery.sort || 'id');
  const sort: RatingListSort =
    sortRaw === 'ratings' || sortRaw === 'updatedAt' ? sortRaw : 'id';
  const order: RatingListOrder =
    String(reqQuery.order || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

  const lowDiff = normalizeShowHideOnly(reqQuery.lowDiff);
  const fourVote = normalizeShowHideOnly(reqQuery.fourVote);
  const myRated = parseMyRated(reqQuery, userId);
  const zeroClears =
    reqQuery.zeroClears === true ||
    reqQuery.zeroClears === 'true' ||
    reqQuery.zeroClears === '1';
  const rankReady =
    reqQuery.rankReady === true ||
    reqQuery.rankReady === 'true' ||
    reqQuery.rankReady === '1';

  let vote: VoteFilter;
  if (reqQuery.vote === 'only' || reqQuery.vote === 'exclude') {
    vote = reqQuery.vote;
  }

  const box = parseRatingSearchBox(String(reqQuery.query || ''));
  if (box.vote) {
    vote = box.vote;
  }

  return {
    offset,
    limit,
    query: box.textQuery,
    sort,
    order,
    lowDiff,
    fourVote,
    myRated,
    zeroClears,
    rankReady,
    vote,
    excludeUniversals: false,
    userId: userId || null,
    levelIdsFilter: box.levelIds,
  };
}

export function ratingListPageCacheKey(params: RatingListQuery): string {
  const payload = JSON.stringify({
    q: params.query,
    sort: params.sort,
    order: params.order,
    lowDiff: params.lowDiff,
    fourVote: params.fourVote,
    zeroClears: params.zeroClears,
    rankReady: params.rankReady,
    vote: params.vote ?? null,
    excludeUniversals: params.excludeUniversals,
    includeRequestBands: params.includeRequestBands ?? null,
    offset: params.offset,
    limit: params.limit,
    levelIds: params.levelIdsFilter ?? null,
  });
  const hash = createHash('sha1').update(payload).digest('hex').slice(0, 16);
  return `cache:layer:admin:ratings:page:${hash}`;
}

function slimDetails(
  details: Array<{
    id: number;
    userId: string;
    rating: string;
    isCommunityRating: boolean;
    username?: string | null;
  }>
): Array<{
  id: number;
  userId: string;
  rating: string;
  isCommunityRating: boolean;
  username: string | null;
}> {
  return details.map((d) => ({
    id: d.id,
    userId: d.userId,
    rating: d.rating,
    isCommunityRating: d.isCommunityRating,
    username: d.username ?? null,
  }));
}

export async function hydrateRatingListRows(
  ratings: Rating[]
): Promise<Record<string, unknown>[]> {
  if (ratings.length === 0) return [];

  const levelIds = [...new Set(ratings.map((r) => r.levelId).filter((id) => id > 0))];
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
        toRate: true,
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
      ],
      include: [
        {
          association: 'levelCredits',
          required: false,
          attributes: ['role'],
          include: [{ association: 'creator', attributes: ['id', 'name'], required: false }],
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
      ],
    });
    for (const level of mysqlLevels) {
      const pruned = pruneLevelForRatingList(
        level.toJSON() as unknown as Record<string, unknown>
      );
      if (pruned && typeof pruned.id === 'number') {
        levelsById.set(pruned.id, pruned);
      }
    }
  }

  const ratingIds = ratings.map((r) => r.id);
  const details = await RatingDetail.findAll({
    where: { ratingId: ratingIds },
    attributes: ['id', 'ratingId', 'userId', 'rating', 'isCommunityRating'],
    include: [
      {
        model: User,
        as: 'user',
        attributes: ['username'],
        required: false,
      },
    ],
  });
  const detailsByRatingId = new Map<number, typeof details>();
  for (const d of details) {
    const list = detailsByRatingId.get(d.ratingId) || [];
    list.push(d);
    detailsByRatingId.set(d.ratingId, list);
  }

  const rows: Record<string, unknown>[] = [];
  for (const rating of ratings) {
    const level = levelsById.get(rating.levelId);
    if (!level) {
      const lvl = await Level.findByPk(rating.levelId, {
        attributes: ['id', 'toRate', 'isDeleted', 'isHidden'],
      });
      if (!lvl || lvl.toRate === false || lvl.isDeleted || lvl.isHidden) {
        Sentry.captureMessage('rating_queue_toRate_divergence', {
          level: 'warning',
          extra: {
            ratingId: rating.id,
            levelId: rating.levelId,
            toRate: lvl?.toRate,
            isDeleted: lvl?.isDeleted,
            isHidden: lvl?.isHidden,
          },
        });
      }
      continue;
    }

    const plain = rating.toJSON() as unknown as Record<string, unknown>;
    delete plain.level;
    plain.level = level;
    plain.details = slimDetails(
      (detailsByRatingId.get(rating.id) || []).map((d) => ({
        id: d.id,
        userId: d.userId,
        rating: d.rating,
        isCommunityRating: d.isCommunityRating,
        username: d.user?.username ?? null,
      }))
    );
    rows.push(plain);
  }
  return rows;
}

async function resolveSearchLevelIds(
  textQuery: string,
  levelIdsFilter: number[] | null
): Promise<number[] | 'empty' | null> {
  if (levelIdsFilter && levelIdsFilter.length > 0) {
    return levelIdsFilter;
  }
  if (!textQuery) {
    return null;
  }

  const pending = await Rating.findAll({
    where: { confirmedAt: null },
    attributes: ['levelId'],
    include: [
      {
        model: Level,
        as: 'level',
        required: true,
        attributes: [],
        where: { toRate: true, isDeleted: false, isHidden: false },
      },
    ],
  });
  const pendingIds = [...new Set(pending.map((r) => r.levelId))];
  if (pendingIds.length === 0) {
    return 'empty';
  }

  const matched = await searchLevelIdsInSet(textQuery, pendingIds);
  if (matched.length === 0) {
    return 'empty';
  }
  return matched;
}

async function fetchRatingListPageInternal(params: RatingListQuery): Promise<RatingListPage> {
  const searchIds = await resolveSearchLevelIds(params.query, params.levelIdsFilter);
  if (searchIds === 'empty') {
    return {
      results: [],
      total: 0,
      offset: params.offset,
      limit: params.limit,
      hasMore: false,
    };
  }

  const includeBandSet = normalizeIncludeRequestBands(params.includeRequestBands);
  if (includeBandSet && includeBandSet.size === 0) {
    return {
      results: [],
      total: 0,
      offset: params.offset,
      limit: params.limit,
      hasMore: false,
    };
  }

  let lowDiff = params.lowDiff;
  if (includeBandSet && includeBandSet.size < 3) {
    lowDiff = lowDiffFilterForRequestBands(
      includeBandSet.has('P'),
      includeBandSet.has('G'),
      includeBandSet.has('U'),
    );
  }

  const ratingWhere: Record<string, unknown> = { confirmedAt: null };
  if (searchIds) {
    ratingWhere.levelId = { [Op.in]: searchIds };
  }
  if (lowDiff === 'hide') {
    ratingWhere.lowDiff = false;
  } else if (lowDiff === 'only') {
    ratingWhere.lowDiff = true;
  }

  const levelWhere: Record<string, unknown> = {
    toRate: true,
    isDeleted: false,
    isHidden: false,
  };
  if (params.zeroClears) {
    levelWhere.clears = 0;
  }

  if (params.vote === 'only') {
    levelWhere.rerateNum = { [Op.regexp]: '^vote' };
  } else if (params.vote === 'exclude') {
    Object.assign(levelWhere, {
      [Op.or]: [
        { rerateNum: { [Op.is]: null } },
        { rerateNum: '' },
        { rerateNum: { [Op.notRegexp]: '^vote' } },
      ],
    });
  }

  if (params.myRated !== 'show' && params.userId) {
    const ratedIdsSql = `(SELECT ratingId FROM rating_details WHERE userId = ${Rating.sequelize!.escape(params.userId)})`;
    ratingWhere.id = {
      [params.myRated === 'only' ? Op.in : Op.notIn]: literal(ratedIdsSql),
    };
    // Match legacy client: hide also hid VOTE queue entries
    if (params.myRated === 'hide' && !params.vote) {
      Object.assign(levelWhere, {
        [Op.or]: [
          { rerateNum: { [Op.is]: null } },
          { rerateNum: '' },
          { rerateNum: { [Op.notRegexp]: '^vote' } },
        ],
      });
    }
  }

  const managerCountSql = managerDetailCountSql(params.rankReady);
  const havingParts: string[] = [];
  if (params.rankReady) {
    havingParts.push(`${managerCountSql} >= 2`);
  } else if (params.fourVote === 'hide') {
    havingParts.push(`${MANAGER_DETAIL_COUNT_SQL} < 4`);
  } else if (params.fourVote === 'only') {
    havingParts.push(`${MANAGER_DETAIL_COUNT_SQL} >= 4`);
  }

  const orderClause: any[] = [];
  if (params.rankReady) {
    orderClause.push([literal(RANK_READY_PGU_BAND_SQL), 'ASC']);
  }
  if (params.sort === 'ratings') {
    orderClause.push([literal(managerCountSql), params.order]);
  } else if (params.sort === 'updatedAt') {
    orderClause.push(['updatedAt', params.order]);
  } else {
    orderClause.push(['levelId', params.order]);
  }

  const levelInclude = {
    model: Level,
    as: 'level',
    required: true,
    attributes: ['id', 'toRate', 'rerateNum'],
    where: levelWhere,
  };

  const findOptions: any = {
    where: ratingWhere,
    include: [levelInclude],
    order: orderClause,
    limit: params.limit,
    offset: params.offset,
    subQuery: false,
  };

  if (havingParts.length > 0) {
    findOptions.attributes = {
      include: [[literal(managerCountSql), 'managerDetailCount']],
    };
    findOptions.group = ['Rating.id'];
    findOptions.having = literal(havingParts.join(' AND '));
  }

  let total: number;
  if (havingParts.length > 0) {
    const countRows = await Rating.findAll({
      where: ratingWhere,
      include: [
        {
          model: Level,
          as: 'level',
          required: true,
          attributes: [],
          where: levelWhere,
        },
      ],
      attributes: ['id'],
      group: ['Rating.id'],
      having: literal(havingParts.join(' AND ')),
      subQuery: false,
    });
    total = countRows.length;
  } else {
    total = await Rating.count({
      where: ratingWhere,
      include: [
        {
          model: Level,
          as: 'level',
          required: true,
          attributes: [],
          where: levelWhere,
        },
      ],
      distinct: true,
      col: 'id',
    });
  }

  const ratings = await Rating.findAll(findOptions);
  let results = await hydrateRatingListRows(ratings);

  const bandFiltered = Boolean(includeBandSet && includeBandSet.size < 3);
  if (bandFiltered && includeBandSet) {
    results = results.filter((row) => {
      const level = row.level as { rerateNum?: string | null } | undefined;
      const band = requestPguBand(
        level?.rerateNum,
        row.requesterFR as string | null | undefined,
        Boolean(row.lowDiff)
      );
      return includeBandSet.has(band);
    });
  } else if (params.excludeUniversals) {
    results = results.filter((row) => {
      const level = row.level as { rerateNum?: string | null } | undefined;
      return !isUniversalRatingProposal(
        level?.rerateNum,
        row.requesterFR as string | null | undefined
      );
    });
  }

  const postFiltered = bandFiltered || params.excludeUniversals;
  return {
    results,
    total: postFiltered ? results.length : total,
    offset: params.offset,
    limit: params.limit,
    hasMore: postFiltered ? false : params.offset + params.limit < total,
  };
}

export async function getRatingListPage(params: RatingListQuery): Promise<RatingListPage> {
  const run = () => fetchRatingListPageInternal(params);

  if (params.myRated !== 'show') {
    return run();
  }

  const storageKey = ratingListPageCacheKey(params);
  try {
    return (
      await getOrFetchCacheLayer({
        storageKey,
        ttlSec: RATING_LIST_CACHE_TTL_SEC,
        tags: [RATING_LIST_CACHE_TAG, 'levels:all'],
        fetch: run,
      })
    ).value;
  } catch (err) {
    logger.error('rating list cache layer failed; computing uncached', err);
    return run();
  }
}

export async function buildSlimListRowByRatingId(
  ratingId: number
): Promise<Record<string, unknown> | null> {
  const rating = await Rating.findByPk(ratingId, {
    include: [
      {
        model: Level,
        as: 'level',
        required: true,
        attributes: ['id', 'toRate'],
        where: { toRate: true, isDeleted: false, isHidden: false },
      },
    ],
  });
  if (!rating || rating.confirmedAt != null) {
    return null;
  }
  const rows = await hydrateRatingListRows([rating]);
  return rows[0] || null;
}

export async function buildCompleteRatingById(
  ratingId: number
): Promise<Record<string, unknown> | null> {
  const rating = await Rating.findByPk(ratingId, {
    include: [
      {
        model: Level,
        as: 'level',
        required: false,
        where: { isDeleted: false, isHidden: false },
      },
      {
        model: RatingDetail,
        as: 'details',
        include: [
          {
            model: User,
            as: 'user',
            attributes: ['id', 'username', 'nickname', 'avatarUrl'],
          },
        ],
      },
    ],
  });
  if (!rating) return null;

  const plain = rating.toJSON() as unknown as Record<string, unknown>;
  const levelPlain = plain.level as Record<string, unknown> | undefined;
  const mysqlLevel = rating.level;

  if (levelPlain && typeof levelPlain.id === 'number') {
    const esMap = await fetchLevelsByIdsFromElasticsearch([levelPlain.id]);
    const esLevel = esMap.get(levelPlain.id);
    if (esLevel) {
      plain.level = esLevel;
    } else {
      plain.level = pruneLevelForRatingList(levelPlain) || levelPlain;
    }
  }

  if (plain.level && (plain.level as { toRate?: boolean }).toRate === false) {
    Sentry.captureMessage('rating_queue_toRate_divergence', {
      level: 'warning',
      extra: {
        ratingId,
        levelId: (plain.level as { id?: number }).id,
        context: 'completeObject',
      },
    });
  }

  // Q difficulties are range placeholders until cleared; after a clear enters the
  // rating queue, raters should watch the first clear video rather than the chart video.
  const displayVideoLink = await resolveQClearDisplayVideoLink({
    levelId: typeof mysqlLevel?.id === 'number' ? mysqlLevel.id : null,
    diffId: mysqlLevel?.diffId ?? null,
    previousDiffId: mysqlLevel?.previousDiffId ?? null,
    averageDifficultyId:
      typeof plain.averageDifficultyId === 'number' ? plain.averageDifficultyId : null,
  });
  if (displayVideoLink) {
    plain.displayVideoLink = displayVideoLink;
  }

  return plain;
}

/** Broadcast a rating list upsert/remove so open RatingPages can patch in place. */
export async function broadcastRatingUpsert(ratingId: number, levelId: number) {
  const listRow = await buildSlimListRowByRatingId(ratingId);
  const complete = await buildCompleteRatingById(ratingId);
  sseManager.broadcastToSources([SSE_SOURCES.admin, SSE_SOURCES.rating], {
    type: 'ratingUpdate',
    data: {
      ratingId,
      levelId,
      action: listRow ? 'upsert' : 'remove',
      listRow,
      complete,
    },
  });
}

/**
 * When the level (or its average) is still on a Q difficulty, return the earliest
 * clear's video link so rating UIs can show the clear instead of the chart video.
 */
export async function resolveQClearDisplayVideoLink(opts: {
  levelId: number | null;
  diffId: number | null;
  previousDiffId?: number | null;
  averageDifficultyId?: number | null;
}): Promise<string | null> {
  if (!opts.levelId || opts.levelId <= 0) return null;

  const diffIds = [
    opts.diffId,
    opts.previousDiffId,
    opts.averageDifficultyId,
  ].filter((id): id is number => typeof id === 'number' && Number.isFinite(id) && id > 0);

  if (diffIds.length === 0) return null;

  const difficulties = await Difficulty.findAll({
    where: { id: [...new Set(diffIds)] },
    attributes: ['id', 'name'],
  });
  const isQ = difficulties.some((d) => String(d.name || '').includes('Q'));
  if (!isQ) return null;

  const firstPass = await Pass.findOne({
    where: {
      levelId: opts.levelId,
      isDeleted: false,
      isHidden: false,
    },
    order: [
      ['vidUploadTime', 'ASC'],
      ['id', 'ASC'],
    ],
    attributes: ['id', 'videoLink'],
  });

  const link = typeof firstPass?.videoLink === 'string' ? firstPass.videoLink.trim() : '';
  return link || null;
}

export async function buildCompleteRatingByLevelId(
  levelId: number
): Promise<Record<string, unknown> | null> {
  const rating = await Rating.findOne({
    where: { levelId, confirmedAt: null },
    attributes: ['id'],
  });
  if (!rating) return null;
  return buildCompleteRatingById(rating.id);
}

export async function pruneLevelForRatingBroadcast(
  levelId: number
): Promise<Record<string, unknown> | null> {
  const esMap = await fetchLevelsByIdsFromElasticsearch([levelId]);
  const level = esMap.get(levelId);
  if (!level) {
    const mysql = await Level.findByPk(levelId);
    if (!mysql || mysql.isDeleted || mysql.isHidden) return null;
    return pruneLevelForRatingList(mysql.toJSON() as unknown as Record<string, unknown>);
  }
  return pruneLevelForRatingList(level);
}

/**
 * SSE payload for rating-page clients: pruned list level, or null when removed from queue.
 */
export async function buildLevelUpdateSseData(levelId: number): Promise<{
  levelId: number;
  level: Record<string, unknown> | null;
}> {
  const level = await pruneLevelForRatingBroadcast(levelId);
  if (!level || level.toRate === false) {
    return { levelId, level: null };
  }
  return { levelId, level };
}
