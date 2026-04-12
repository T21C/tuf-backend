import { redis } from '@/server/services/RedisService.js';
import { logger } from '@/server/services/LoggerService.js';

const KEY_PREFIX = 'tuf:job:';

/** Redis pub/sub channel for live job progress (SSE subscribers). */
export function jobProgressRedisChannel(jobId: string): string {
  return `${KEY_PREFIX}pub:${jobId}`;
}

/** Client-generated ids use randomUUID() (v4). */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidJobId(s: unknown): s is string {
  return typeof s === 'string' && s.length <= 80 && UUID_V4_RE.test(s.trim());
}

export interface JobProgressRecord {
  id: string;
  kind?: string;
  phase?: string;
  percent?: number | null;
  message?: string;
  meta?: Record<string, unknown>;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
  ownerUserId?: string | null;
}

export type JobProgressPatch = Partial<
  Pick<JobProgressRecord, 'kind' | 'phase' | 'percent' | 'message' | 'meta' | 'error' | 'ownerUserId'>
>;

function jobKey(jobId: string): string {
  return `${KEY_PREFIX}${jobId}`;
}

function defaultTtlSeconds(): number {
  const raw = process.env.JOB_PROGRESS_TTL_SECONDS;
  if (raw === undefined || raw === '') {
    return 86400;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 86400;
}

function mergeMeta(
  existing: Record<string, unknown> | undefined,
  patch: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (patch === undefined) {
    return existing;
  }
  if (existing === undefined) {
    return {...patch};
  }
  return {...existing, ...patch};
}

export const jobProgressService = {
  async get(jobId: string): Promise<JobProgressRecord | null> {
    const rec = await redis.get<JobProgressRecord>(jobKey(jobId));
    if (!rec) {
      return null;
    }
    return rec;
  },

  /**
   * Merge partial fields into the job document. Used by trusted main-server code (can set owner).
   */
  async patchTrusted(jobId: string, partial: JobProgressPatch, ttlSeconds?: number): Promise<JobProgressRecord | null> {
    return mergeAndSave(jobId, partial, {allowOwner: true}, ttlSeconds);
  },

  /**
   * Merge from CDN / ingest HTTP — ownerUserId in partial is ignored.
   */
  async patchFromIngest(jobId: string, partial: JobProgressPatch, ttlSeconds?: number): Promise<JobProgressRecord | null> {
    const {ownerUserId: _ignored, ...rest} = partial;
    return mergeAndSave(jobId, rest, {allowOwner: false}, ttlSeconds);
  },

  canUserRead(record: JobProgressRecord, userId: string | undefined): boolean {
    if (!userId) {
      return false;
    }
    if (record.ownerUserId == null || record.ownerUserId === '') {
      return false;
    }
    return record.ownerUserId === userId;
  }
};

async function mergeAndSave(
  jobId: string,
  partial: JobProgressPatch,
  options: {allowOwner: boolean},
  ttlSeconds?: number
): Promise<JobProgressRecord | null> {
  const key = jobKey(jobId);
  const now = new Date().toISOString();
  const ttl = ttlSeconds ?? defaultTtlSeconds();

  try {
    const existing = await redis.get<JobProgressRecord>(key);
    const next: JobProgressRecord = existing
      ? {...existing}
      : {
          id: jobId,
          createdAt: now,
          updatedAt: now
        };

    if (partial.kind !== undefined) {
      next.kind = partial.kind;
    }
    if (partial.phase !== undefined) {
      next.phase = partial.phase;
    }
    if (partial.percent !== undefined) {
      next.percent = partial.percent;
    }
    if (partial.message !== undefined) {
      next.message = partial.message;
    }
    if (partial.error !== undefined) {
      next.error = partial.error;
    }
    if (partial.meta !== undefined) {
      next.meta = mergeMeta(next.meta, partial.meta);
    }
    if (options.allowOwner && partial.ownerUserId !== undefined) {
      if (!next.ownerUserId) {
        next.ownerUserId = partial.ownerUserId;
      }
    }

    next.updatedAt = now;
    if (!existing) {
      next.createdAt = now;
      if (!next.id) {
        next.id = jobId;
      }
    }

    const ok = await redis.set(key, next, ttl);
    if (!ok) {
      logger.warn('JobProgress: Redis set returned false', {jobId});
      return null;
    }

    await redis.publish(jobProgressRedisChannel(jobId), JSON.stringify({type: 'job', data: next}));

    return next;
  } catch (e) {
    logger.error('JobProgress: merge failed', {
      jobId,
      error: e instanceof Error ? e.message : String(e)
    });
    return null;
  }
}
