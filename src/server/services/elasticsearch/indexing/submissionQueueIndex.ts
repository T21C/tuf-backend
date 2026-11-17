import { Op } from 'sequelize';
import client, { submissionQueueIndexName } from '@/config/elasticsearch.js';
import { logger } from '@/server/services/core/LoggerService.js';
import User from '@/models/auth/User.js';
import LevelSubmission from '@/models/submissions/LevelSubmission.js';
import LevelSubmissionArtistRequest from '@/models/submissions/LevelSubmissionArtistRequest.js';
import LevelSubmissionCreatorRequest from '@/models/submissions/LevelSubmissionCreatorRequest.js';
import LevelSubmissionSongRequest from '@/models/submissions/LevelSubmissionSongRequest.js';
import LevelSubmissionTeamRequest from '@/models/submissions/LevelSubmissionTeamRequest.js';
import { PassSubmission } from '@/models/submissions/PassSubmission.js';
import { BATCH_SIZE, FULL_REINDEX_PAGE_SIZE, MAX_BATCH_SIZE } from '@/server/services/elasticsearch/misc/constants.js';
import {
  fetchSubmissionQueueDocuments,
  listPendingSubmissionIds,
  submitterRatioStats,
} from '@/server/services/elasticsearch/fetching/submissionQueueFetch.js';
import {
  submissionQueueDocId,
  type SubmissionQueueKind,
} from '@/server/services/elasticsearch/indexing/submissionQueueIndexDocument.js';

function uniquePositiveIds(ids: Array<number | null | undefined>): number[] {
  return [...new Set(ids.filter((id): id is number => id != null && Number.isInteger(id) && id > 0))];
}

async function bulkIndex(
  kind: SubmissionQueueKind,
  docs: Array<{ id: number; document: Record<string, unknown> }>,
  refresh: boolean,
): Promise<void> {
  for (let offset = 0; offset < docs.length; offset += BATCH_SIZE) {
    const batch = docs.slice(offset, offset + BATCH_SIZE);
    const operations = batch.flatMap((doc) => [
      { index: { _index: submissionQueueIndexName, _id: submissionQueueDocId(kind, doc.id) } },
      doc.document,
    ]);
    if (operations.length > 0) {
      await client.bulk({ operations, refresh });
    }
  }
}

export async function deletePendingSubmissionDocument(
  kind: SubmissionQueueKind,
  id: number,
): Promise<void> {
  if (!Number.isInteger(id) || id <= 0) return;
  try {
    await client.delete({
      index: submissionQueueIndexName,
      id: submissionQueueDocId(kind, id),
    });
  } catch (error: unknown) {
    const status = (error as { meta?: { statusCode?: number } })?.meta?.statusCode;
    if (status === 404) return;
    logger.error(`Error deleting pending ${kind} submission ${id} from index:`, error);
    throw error;
  }
}

export async function reindexPendingSubmissions(
  kind: SubmissionQueueKind,
  ids: number[],
  opts: { refresh?: boolean } = {},
): Promise<void> {
  const unique = uniquePositiveIds(ids);
  if (unique.length === 0) return;
  const refresh = Boolean(opts.refresh);
  const present = new Set<number>();
  for (let offset = 0; offset < unique.length; offset += MAX_BATCH_SIZE) {
    const chunk = unique.slice(offset, offset + MAX_BATCH_SIZE);
    const documents = await fetchSubmissionQueueDocuments(kind, chunk);
    documents.forEach((doc) => present.add(doc.id));
    await bulkIndex(
      kind,
      documents.map((document) => ({ id: document.id, document })),
      refresh,
    );
  }
  const missing = unique.filter((id) => !present.has(id));
  await Promise.all(missing.map((id) => deletePendingSubmissionDocument(kind, id)));
}

export async function refreshPendingSubmitterRatio(
  kind: SubmissionQueueKind,
  userId: string | null | undefined,
  opts: { refresh?: boolean } = {},
): Promise<void> {
  if (!userId) return;
  const stats = (await submitterRatioStats(kind, [userId])).get(userId);
  const accepted = stats?.accepted ?? 0;
  const decided = stats?.total ?? 0;
  const ratio = stats?.ratio ?? null;
  try {
    await client.updateByQuery({
      index: submissionQueueIndexName,
      refresh: Boolean(opts.refresh),
      query: {
        bool: {
          filter: [
            { term: { kind } },
            { term: { userId } },
          ],
        },
      },
      script: {
        lang: 'painless',
        source:
          'ctx._source.ratio = params.ratio; ctx._source.acceptedCount = params.accepted; ctx._source.decidedCount = params.decided;',
        params: { ratio, accepted, decided },
      },
    });
  } catch (error) {
    logger.error(`Error patching pending ${kind} submitter ratio for ${userId}:`, error);
    throw error;
  }
}

export async function syncPendingSubmissionDocument(
  kind: SubmissionQueueKind,
  id: number,
  opts: { refresh?: boolean } = {},
): Promise<void> {
  if (!Number.isInteger(id) || id <= 0) return;
  const finder = (kind === 'pass' ? PassSubmission : LevelSubmission) as typeof LevelSubmission;
  const row = await finder.findByPk(id, { attributes: ['id', 'status', 'userId'] });
  const refresh = opts.refresh !== false;
  if (!row || row.status !== 'pending') {
    await deletePendingSubmissionDocument(kind, id);
    await refreshPendingSubmitterRatio(kind, row?.userId, { refresh });
    return;
  }
  await reindexPendingSubmissions(kind, [id], { refresh });
}

export async function safeSyncPendingSubmissionDocument(
  kind: SubmissionQueueKind,
  id: number,
  opts: { refresh?: boolean } = {},
): Promise<void> {
  try {
    await syncPendingSubmissionDocument(kind, id, opts);
  } catch (error) {
    logger.error(`Failed to sync pending ${kind} submission ${id} into the queue index:`, error);
  }
}

export async function reindexAllPendingSubmissions(): Promise<void> {
  let processed = 0;
  for (const kind of ['level', 'pass'] as const) {
    let afterId = 0;
    while (true) {
      const ids = await listPendingSubmissionIds(kind, afterId, FULL_REINDEX_PAGE_SIZE);
      if (ids.length === 0) break;
      await reindexPendingSubmissions(kind, ids, { refresh: false });
      processed += ids.length;
      afterId = ids[ids.length - 1];
      if (ids.length < FULL_REINDEX_PAGE_SIZE) break;
    }
  }
  logger.info(`Pending submission queue reindexing complete. Total indexed: ${processed}`);
}

async function pendingIdsFromRows(rows: Array<{ id?: number | null }>): Promise<number[]> {
  return uniquePositiveIds(rows.map((row) => row.id ?? null));
}

export async function pendingPassIdsForLevel(levelId: number): Promise<number[]> {
  if (!Number.isInteger(levelId) || levelId <= 0) return [];
  const rows = await PassSubmission.findAll({
    where: { status: 'pending', levelId },
    attributes: ['id'],
    raw: true,
  });
  return pendingIdsFromRows(rows as Array<{ id: number }>);
}

export async function pendingPassIdsForPlayer(playerId: number): Promise<number[]> {
  if (!Number.isInteger(playerId) || playerId <= 0) return [];
  const rows = await PassSubmission.findAll({
    where: {
      status: 'pending',
      [Op.or]: [{ passerId: playerId }, { assignedPlayerId: playerId }],
    },
    attributes: ['id'],
    raw: true,
  });
  return pendingIdsFromRows(rows as Array<{ id: number }>);
}

export async function pendingSubmissionIdsForUser(
  kind: SubmissionQueueKind,
  userId: string,
): Promise<number[]> {
  if (!userId) return [];
  const finder = (kind === 'pass' ? PassSubmission : LevelSubmission) as typeof LevelSubmission;
  const rows = await finder.findAll({
    where: { status: 'pending', userId },
    attributes: ['id'],
    raw: true,
  });
  return pendingIdsFromRows(rows as Array<{ id: number }>);
}

export async function pendingLevelIdsForCreator(creatorId: number): Promise<number[]> {
  if (!Number.isInteger(creatorId) || creatorId <= 0) return [];
  const rows = await LevelSubmissionCreatorRequest.findAll({
    where: { creatorId },
    attributes: ['submissionId'],
    include: [{
      model: LevelSubmission,
      as: 'submission',
      required: true,
      attributes: [],
      where: { status: 'pending' },
    }],
    raw: true,
  }) as unknown as Array<{ submissionId: number }>;
  return uniquePositiveIds(rows.map((row) => row.submissionId));
}

export async function pendingLevelIdsForSong(songId: number): Promise<number[]> {
  if (!Number.isInteger(songId) || songId <= 0) return [];
  const [direct, requested] = await Promise.all([
    LevelSubmission.findAll({
      where: { status: 'pending', songId },
      attributes: ['id'],
      raw: true,
    }) as unknown as Promise<Array<{ id: number }>>,
    LevelSubmissionSongRequest.findAll({
      where: { songId },
      attributes: ['submissionId'],
      include: [{
        model: LevelSubmission,
        as: 'submission',
        required: true,
        attributes: [],
        where: { status: 'pending' },
      }],
      raw: true,
    }) as unknown as Promise<Array<{ submissionId: number }>>,
  ]);
  return uniquePositiveIds([
    ...direct.map((row) => row.id),
    ...requested.map((row) => row.submissionId),
  ]);
}

export async function pendingLevelIdsForArtist(artistId: number): Promise<number[]> {
  if (!Number.isInteger(artistId) || artistId <= 0) return [];
  const [direct, requested] = await Promise.all([
    LevelSubmission.findAll({
      where: { status: 'pending', artistId },
      attributes: ['id'],
      raw: true,
    }) as unknown as Promise<Array<{ id: number }>>,
    LevelSubmissionArtistRequest.findAll({
      where: { artistId },
      attributes: ['submissionId'],
      include: [{
        model: LevelSubmission,
        as: 'submission',
        required: true,
        attributes: [],
        where: { status: 'pending' },
      }],
      raw: true,
    }) as unknown as Promise<Array<{ submissionId: number }>>,
  ]);
  return uniquePositiveIds([
    ...direct.map((row) => row.id),
    ...requested.map((row) => row.submissionId),
  ]);
}

export async function pendingLevelIdsForTeam(teamId: number): Promise<number[]> {
  if (!Number.isInteger(teamId) || teamId <= 0) return [];
  const [direct, requested] = await Promise.all([
    LevelSubmission.findAll({
      where: { status: 'pending', teamId },
      attributes: ['id'],
      raw: true,
    }) as unknown as Promise<Array<{ id: number }>>,
    LevelSubmissionTeamRequest.findAll({
      where: { teamId },
      attributes: ['submissionId'],
      include: [{
        model: LevelSubmission,
        as: 'submission',
        required: true,
        attributes: [],
        where: { status: 'pending' },
      }],
      raw: true,
    }) as unknown as Promise<Array<{ submissionId: number }>>,
  ]);
  return uniquePositiveIds([
    ...direct.map((row) => row.id),
    ...requested.map((row) => row.submissionId),
  ]);
}

export async function pendingPassIdsForLevels(levelIds: number[]): Promise<number[]> {
  const unique = uniquePositiveIds(levelIds);
  if (unique.length === 0) return [];
  const rows = await PassSubmission.findAll({
    where: { status: 'pending', levelId: { [Op.in]: unique } },
    attributes: ['id'],
    raw: true,
  });
  return pendingIdsFromRows(rows as Array<{ id: number }>);
}

export async function reindexPendingPassesForLevel(levelId: number): Promise<void> {
  const ids = await pendingPassIdsForLevel(levelId);
  await reindexPendingSubmissions('pass', ids);
}

export async function reindexPendingPassesForLevels(levelIds: number[]): Promise<void> {
  await reindexPendingSubmissions('pass', await pendingPassIdsForLevels(levelIds));
}

export async function reindexPendingLevels(ids: number[]): Promise<void> {
  await reindexPendingSubmissions('level', ids);
}

export async function reindexPendingSubmissionsForPlayer(playerId: number): Promise<void> {
  const [passIds, users] = await Promise.all([
    pendingPassIdsForPlayer(playerId),
    User.findAll({
      where: { playerId },
      attributes: ['id'],
      raw: true,
    }),
  ]);
  const userIds = (users as unknown as Array<{ id: string }>).map((user) => user.id);
  const [levelIds, extraPassIds] = await Promise.all([
    Promise.all(userIds.map((userId) => pendingSubmissionIdsForUser('level', userId))),
    Promise.all(userIds.map((userId) => pendingSubmissionIdsForUser('pass', userId))),
  ]);
  await reindexPendingSubmissions('pass', [...passIds, ...extraPassIds.flat()]);
  await reindexPendingSubmissions('level', levelIds.flat());
}

export async function reindexPendingSubmissionsForUser(userId: string): Promise<void> {
  if (!userId) return;
  const [levelIds, passIds] = await Promise.all([
    pendingSubmissionIdsForUser('level', userId),
    pendingSubmissionIdsForUser('pass', userId),
  ]);
  await reindexPendingSubmissions('level', levelIds);
  await reindexPendingSubmissions('pass', passIds);
}
