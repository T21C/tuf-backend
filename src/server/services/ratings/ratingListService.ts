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
import { isUniversalRatingProposal } from '@/misc/utils/data/RatingUtils.js';

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
  hideRated: boolean;
  vote: VoteFilter;
  excludeUniversals: boolean;
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
  const hideRated =
    (reqQuery.hideRated === true ||
      reqQuery.hideRated === 'true' ||
      reqQuery.hideRated === '1') &&
    Boolean(userId);

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
    hideRated,
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
    vote: params.vote ?? null,
    excludeUniversals: params.excludeUniversals,
    offset: params.offset,
    limit: params.limit,
    levelIds: params.levelIdsFilter ?? null,
  });
  const hash = createHash('sha1').update(payload).digest('hex').slice(0, 16);
  return `cache:layer:admin:ratings:page:${hash}`;
}

function slimDetails(
  details: Array<{ id: number; userId: string; rating: string; isCommunityRating: boolean }>
): Array<{ id: number; userId: string; rating: string; isCommunityRating: boolean }> {
  return details.map((d) => ({
    id: d.id,
    userId: d.userId,
    rating: d.rating,
    isCommunityRating: d.isCommunityRating,
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

  const ratingWhere: Record<string, unknown> = { confirmedAt: null };
  if (searchIds) {
    ratingWhere.levelId = { [Op.in]: searchIds };
  }
  if (params.lowDiff === 'hide') {
    ratingWhere.lowDiff = false;
  } else if (params.lowDiff === 'only') {
    ratingWhere.lowDiff = true;
  }

  const levelWhere: Record<string, unknown> = {
    toRate: true,
    isDeleted: false,
    isHidden: false,
  };

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

  if (params.hideRated && params.userId) {
    ratingWhere.id = {
      [Op.notIn]: literal(
        `(SELECT ratingId FROM rating_details WHERE userId = ${Rating.sequelize!.escape(params.userId)})`
      ),
    };
    // Match legacy client: hideRated also hid VOTE queue entries
    if (!params.vote) {
      Object.assign(levelWhere, {
        [Op.or]: [
          { rerateNum: { [Op.is]: null } },
          { rerateNum: '' },
          { rerateNum: { [Op.notRegexp]: '^vote' } },
        ],
      });
    }
  }

  const havingParts: string[] = [];
  if (params.fourVote === 'hide') {
    havingParts.push(`${MANAGER_DETAIL_COUNT_SQL} < 4`);
  } else if (params.fourVote === 'only') {
    havingParts.push(`${MANAGER_DETAIL_COUNT_SQL} >= 4`);
  }

  const orderClause: any[] = [];
  if (params.sort === 'ratings') {
    orderClause.push([literal(MANAGER_DETAIL_COUNT_SQL), params.order]);
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
      include: [[literal(MANAGER_DETAIL_COUNT_SQL), 'managerDetailCount']],
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

  if (params.excludeUniversals) {
    results = results.filter((row) => {
      const level = row.level as { rerateNum?: string | null } | undefined;
      return !isUniversalRatingProposal(
        level?.rerateNum,
        row.requesterFR as string | null | undefined
      );
    });
  }

  return {
    results,
    total: params.excludeUniversals ? results.length : total,
    offset: params.offset,
    limit: params.limit,
    hasMore: params.excludeUniversals
      ? false
      : params.offset + params.limit < total,
  };
}

export async function getRatingListPage(params: RatingListQuery): Promise<RatingListPage> {
  const run = () => fetchRatingListPageInternal(params);

  if (params.hideRated) {
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
