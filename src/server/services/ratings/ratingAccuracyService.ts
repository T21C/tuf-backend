import {Op, type Transaction} from 'sequelize';
import Difficulty from '@/models/levels/Difficulty.js';
import Rating from '@/models/levels/Rating.js';
import RatingDetail from '@/models/levels/RatingDetail.js';
import RatingAccuracySample from '@/models/levels/RatingAccuracySample.js';
import RatingAccuracyStats from '@/models/levels/RatingAccuracyStats.js';
import {
  scoreRatingAccuracy,
  shrinkMean,
  type DifficultyRef,
  type RatingAccuracyChart,
} from '@/misc/utils/data/ratingAccuracy.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {CacheInvalidation} from '@/server/middleware/cache.js';

const RATING_ACCURACY_CACHE_TAG = 'admin:rating-accuracy';

function autoraterUserId(): string | null {
  const id = process.env.AUTORATER_UUID;
  return id && id.trim() ? id.trim() : null;
}

function toDifficultyRef(d: Difficulty): DifficultyRef {
  return {
    id: d.id,
    name: d.name,
    type: d.type,
    sortOrder: d.sortOrder,
  };
}

async function loadDifficultyRefs(transaction?: Transaction): Promise<DifficultyRef[]> {
  const rows = await Difficulty.findAll({
    attributes: ['id', 'name', 'type', 'sortOrder'],
    transaction,
  });
  return rows.map(toDifficultyRef);
}

function meanOrZero(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export async function rebuildStatsForUsers(
  userIds: string[],
  transaction?: Transaction,
): Promise<number> {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return 0;

  const samples = await RatingAccuracySample.findAll({
    where: {userId: {[Op.in]: unique}},
    attributes: ['userId', 'isCommunityRating', 'track', 'score'],
    transaction,
  });

  type Bucket = {pgu: number[]; special: number[]};
  const grouped = new Map<string, Bucket>();
  const keyOf = (userId: string, isCommunity: boolean) =>
    `${userId}::${isCommunity ? '1' : '0'}`;

  for (const sample of samples) {
    const key = keyOf(sample.userId, sample.isCommunityRating);
    let bucket = grouped.get(key);
    if (!bucket) {
      bucket = {pgu: [], special: []};
      grouped.set(key, bucket);
    }
    if (sample.track === 'pgu' && sample.score != null && Number.isFinite(sample.score)) {
      bucket.pgu.push(sample.score);
    } else if (
      sample.track === 'special' &&
      sample.score != null &&
      Number.isFinite(sample.score)
    ) {
      bucket.special.push(sample.score);
    }
  }

  await RatingAccuracyStats.destroy({
    where: {userId: {[Op.in]: unique}},
    transaction,
  });

  let upserts = 0;
  for (const [key, bucket] of grouped) {
    const [userId, flag] = key.split('::');
    if (!userId) continue;
    const pguN = bucket.pgu.length;
    const specialN = bucket.special.length;
    if (pguN === 0 && specialN === 0) continue;
    const isCommunityRating = flag === '1';
    const pguRawMean = meanOrZero(bucket.pgu);
    const specialRawMean = meanOrZero(bucket.special);
    await RatingAccuracyStats.upsert(
      {
        userId,
        isCommunityRating,
        pguRawMean,
        pguN,
        pguShrunkMean: shrinkMean(pguRawMean, pguN),
        specialRawMean,
        specialN,
      },
      {transaction},
    );
    upserts += 1;
  }
  return upserts;
}

export async function rebuildAllStats(transaction?: Transaction): Promise<number> {
  const rows = await RatingAccuracySample.findAll({
    attributes: ['userId'],
    group: ['userId'],
    transaction,
  });
  const userIds = rows.map((r) => r.userId);
  return rebuildStatsForUsers(userIds, transaction);
}

export async function freezeAndUpsertRating(
  ratingId: number,
  snapshot: {settledDiffId: number | null; clearsAtSettle: number | null},
  transaction?: Transaction,
): Promise<{samples: number; skippedAutorater: number; skippedNoSettle: number}> {
  await Rating.update(
    {
      settledDiffId: snapshot.settledDiffId,
      clearsAtSettle: snapshot.clearsAtSettle,
    },
    {where: {id: ratingId}, transaction},
  );

  const details = await RatingDetail.findAll({
    where: {ratingId},
    transaction,
  });

  const botId = autoraterUserId();
  const difficulties = await loadDifficultyRefs(transaction);
  let settled: DifficultyRef | null = null;
  if (snapshot.settledDiffId != null) {
    settled =
      difficulties.find((d) => d.id === snapshot.settledDiffId) ??
      null;
    if (!settled) {
      const row = await Difficulty.findByPk(snapshot.settledDiffId, {transaction});
      if (row) settled = toDifficultyRef(row);
    }
  }

  let samples = 0;
  let skippedAutorater = 0;
  let skippedNoSettle = 0;
  const touchedUsers: string[] = [];

  if (!settled) {
    skippedNoSettle = details.filter((d) => !botId || d.userId !== botId).length;
    logger.warn('rating accuracy freeze skipped: no settled difficulty', {
      ratingId,
      settledDiffId: snapshot.settledDiffId,
    });
    return {samples, skippedAutorater, skippedNoSettle};
  }

  for (const detail of details) {
    if (botId && detail.userId === botId) {
      skippedAutorater += 1;
      continue;
    }
    const frozenRating = String(detail.rating ?? '');
    const scored = scoreRatingAccuracy({
      frozenRating,
      settled,
      clearsAtSettle: snapshot.clearsAtSettle,
      difficulties,
    });
    await RatingAccuracySample.upsert(
      {
        ratingDetailId: detail.id,
        ratingId,
        userId: detail.userId,
        isCommunityRating: Boolean(detail.isCommunityRating),
        track: scored.track,
        scoringMode: scored.scoringMode,
        frozenRating: frozenRating.slice(0, 254),
        settledDiffId: snapshot.settledDiffId,
        clearsAtSettle: snapshot.clearsAtSettle,
        score: scored.score,
        chart: scored.chart as RatingAccuracyChart,
      },
      {transaction},
    );
    samples += 1;
    touchedUsers.push(detail.userId);
  }

  await rebuildStatsForUsers(touchedUsers, transaction);
  return {samples, skippedAutorater, skippedNoSettle};
}

export async function invalidateRatingAccuracyCache(): Promise<void> {
  await CacheInvalidation.invalidateTag(RATING_ACCURACY_CACHE_TAG).catch((err) =>
    logger.error('Failed to invalidate rating accuracy cache', err),
  );
}

export function serializeAccuracySample(sample: RatingAccuracySample | Record<string, unknown> | null | undefined) {
  if (!sample) return null;
  const row = sample as RatingAccuracySample;
  return {
    score: row.score,
    track: row.track,
    scoringMode: row.scoringMode,
    frozenRating: row.frozenRating,
    chart: row.chart,
  };
}

export function attachSerializedAccuracySamples(plain: Record<string, unknown>): void {
  const details = plain.details;
  if (!Array.isArray(details)) return;
  for (const detail of details) {
    if (!detail || typeof detail !== 'object') continue;
    const row = detail as Record<string, unknown>;
    row.accuracySample = serializeAccuracySample(
      (row.accuracySample as RatingAccuracySample | null) ?? null,
    );
  }
}

export {RATING_ACCURACY_CACHE_TAG};
