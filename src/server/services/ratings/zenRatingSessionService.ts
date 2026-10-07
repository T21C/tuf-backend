import ZenRatingSession from '@/models/levels/ZenRatingSession.js';
import {buildCompleteRatingById} from '@/server/services/ratings/ratingListService.js';
import {
  compactZenSessionProgress,
  isUnfinishedZenPayload,
  sanitizeZenSessionPayload,
  ZenSessionError,
  type ZenSessionPayload,
} from '@/server/services/ratings/zenRatingSessionPayload.js';

const HYDRATE_CHUNK = 10;

export type HydratedZenSession = ZenSessionPayload & {
  cards: Record<string, unknown>[];
};

async function loadStoredPayload(
  userId: string
): Promise<{row: ZenRatingSession; payload: ZenSessionPayload} | null> {
  const row = await ZenRatingSession.findByPk(userId);
  if (!row) return null;
  try {
    return {row, payload: sanitizeZenSessionPayload(row.payload)};
  } catch {
    await row.destroy();
    return null;
  }
}

export async function getZenSessionPayload(
  userId: string
): Promise<ZenSessionPayload | null> {
  const stored = await loadStoredPayload(userId);
  return stored?.payload ?? null;
}

export async function getHydratedZenSession(
  userId: string
): Promise<HydratedZenSession | null> {
  const stored = await loadStoredPayload(userId);
  if (!stored) return null;

  const {row, payload} = stored;
  const builtById = new Map<number, Record<string, unknown>>();
  const ids = payload.ratingIds;

  for (let i = 0; i < ids.length; i += HYDRATE_CHUNK) {
    const chunk = ids.slice(i, i + HYDRATE_CHUNK);
    const built = await Promise.all(chunk.map((id) => buildCompleteRatingById(id)));
    for (const complete of built) {
      if (!complete) continue;
      if (complete.confirmedAt != null) continue;
      const id = Number(complete.id);
      if (!Number.isFinite(id) || id <= 0) continue;
      builtById.set(id, complete);
    }
  }

  const surviving = new Set(builtById.keys());
  const {payload: compacted, changed} = compactZenSessionProgress(
    payload,
    surviving
  );

  if (compacted.ratingIds.length === 0) {
    await row.destroy();
    return null;
  }

  if (changed) {
    row.payload = compacted as unknown as Record<string, unknown>;
    row.changed('payload', true);
    row.updatedAt = new Date();
    await row.save();
  }

  const cards: Record<string, unknown>[] = [];
  for (const id of compacted.ratingIds) {
    const card = builtById.get(id);
    if (card) cards.push(card);
  }

  return {...compacted, cards};
}

export async function upsertZenSession(
  userId: string,
  body: unknown
): Promise<ZenSessionPayload> {
  const payload = sanitizeZenSessionPayload(body);
  const [row] = await ZenRatingSession.findOrCreate({
    where: {userId},
    defaults: {userId, payload: payload as unknown as Record<string, unknown>},
  });
  row.payload = payload as unknown as Record<string, unknown>;
  row.changed('payload', true);
  row.updatedAt = new Date();
  await row.save();
  return payload;
}

export async function deleteZenSession(userId: string): Promise<void> {
  await ZenRatingSession.destroy({where: {userId}});
}

export async function assertNormalRatingAllowed(userId: string): Promise<void> {
  const payload = await getZenSessionPayload(userId);
  if (isUnfinishedZenPayload(payload)) {
    throw new ZenSessionError(
      'Finish or discard Zen Mode before using the rating queue',
      403
    );
  }
}

export async function assertZenSubmitAllowed(
  userId: string,
  ratingId: number
): Promise<void> {
  const payload = await getZenSessionPayload(userId);
  if (!payload || !payload.ratingIds.includes(ratingId)) {
    throw new ZenSessionError(
      'Zen rating is only allowed for the current Zen deck',
      403
    );
  }
}
