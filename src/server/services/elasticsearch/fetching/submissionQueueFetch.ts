import { Op, fn, col } from 'sequelize';
import Difficulty from '@/models/levels/Difficulty.js';
import Level from '@/models/levels/Level.js';
import LevelAlias from '@/models/levels/LevelAlias.js';
import Player from '@/models/players/Player.js';
import PlayerAlias from '@/models/players/PlayerAlias.js';
import User from '@/models/auth/User.js';
import Creator from '@/models/credits/Creator.js';
import { CreatorAlias } from '@/models/credits/CreatorAlias.js';
import Team from '@/models/credits/Team.js';
import { TeamAlias } from '@/models/credits/TeamAlias.js';
import Song from '@/models/songs/Song.js';
import SongAlias from '@/models/songs/SongAlias.js';
import Artist from '@/models/artists/Artist.js';
import ArtistAlias from '@/models/artists/ArtistAlias.js';
import LevelSubmission from '@/models/submissions/LevelSubmission.js';
import LevelSubmissionCreatorRequest from '@/models/submissions/LevelSubmissionCreatorRequest.js';
import LevelSubmissionTeamRequest from '@/models/submissions/LevelSubmissionTeamRequest.js';
import LevelSubmissionSongRequest from '@/models/submissions/LevelSubmissionSongRequest.js';
import LevelSubmissionArtistRequest from '@/models/submissions/LevelSubmissionArtistRequest.js';
import { PassSubmission } from '@/models/submissions/PassSubmission.js';
import {
  buildSubmissionQueueIndexDocument,
  type SubmissionQueueIndexDocument,
  type SubmissionQueueKind,
} from '@/server/services/elasticsearch/indexing/submissionQueueIndexDocument.js';
import {
  difficultyTextSortValue,
  ratioSortValue,
} from '@/server/services/submissions/pendingSubmissionSort.js';
import { passDifficultySubtype } from '@/server/services/submissions/passDifficultySubtype.js';

const ID_CHUNK = 500;

type StatusCountRow = {
  userId: string;
  status: string;
  count: string | number;
};

export type SubmitterRatioStats = {
  ratio: number | null;
  accepted: number;
  declined: number;
  total: number;
};

type NamedId = { id?: number | null; name?: string | null };

function uniquePositiveIds(ids: Array<number | null | undefined>): number[] {
  return [...new Set(ids.filter((id): id is number => id != null && Number.isInteger(id) && id > 0))];
}

function aliasNames(rows: Array<{ name?: string | null; alias?: string | null }> | undefined): string[] {
  return (rows || []).flatMap((row) => [row.name, row.alias]).filter((value): value is string => Boolean(value));
}

async function difficultyNameOrders(): Promise<Map<string, number>> {
  const difficulties = await Difficulty.findAll({ attributes: ['name', 'sortOrder'] });
  const byName = new Map<string, number>();
  for (const difficulty of difficulties) {
    const name = String(difficulty.name || '').trim().toLowerCase();
    const order = Number(difficulty.sortOrder);
    if (name && Number.isFinite(order)) byName.set(name, order);
  }
  return byName;
}

export async function submitterRatioStats(
  kind: SubmissionQueueKind,
  userIds: Array<string | null | undefined>,
): Promise<Map<string, SubmitterRatioStats>> {
  const unique = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  const totals = new Map<string, { accepted: number; declined: number }>();
  const finder = (kind === 'pass' ? PassSubmission : LevelSubmission) as typeof LevelSubmission;
  for (let offset = 0; offset < unique.length; offset += ID_CHUNK) {
    const chunk = unique.slice(offset, offset + ID_CHUNK);
    const rows = await finder.findAll({
      where: {
        userId: { [Op.in]: chunk },
        status: { [Op.in]: ['approved', 'declined'] },
      },
      attributes: ['userId', 'status', [fn('COUNT', col('id')), 'count']],
      group: ['userId', 'status'],
      raw: true,
    }) as unknown as StatusCountRow[];
    for (const row of rows) {
      const current = totals.get(row.userId) ?? { accepted: 0, declined: 0 };
      const count = Number(row.count) || 0;
      if (row.status === 'approved') current.accepted = count;
      else if (row.status === 'declined') current.declined = count;
      totals.set(row.userId, current);
    }
  }
  const stats = new Map<string, SubmitterRatioStats>();
  for (const userId of unique) {
    const current = totals.get(userId) ?? { accepted: 0, declined: 0 };
    stats.set(userId, {
      ratio: ratioSortValue(current.accepted, current.declined),
      accepted: current.accepted,
      declined: current.declined,
      total: current.accepted + current.declined,
    });
  }
  return stats;
}

export function emptySubmitterRatioStats(): SubmitterRatioStats {
  return { ratio: null, accepted: 0, declined: 0, total: 0 };
}

type PassIndexRow = {
  id: number;
  isLocked?: boolean | number | null;
  createdAt: Date | string;
  userId?: string | null;
  levelId?: number | null;
  passer?: string | null;
  passerId?: number | null;
  assignedPlayerId?: number | null;
  title?: string | null;
  feelingDifficulty?: string | null;
  expectedDifficulty?: string | null;
  assignedPlayer?: (NamedId & { playerAliases?: Array<{ name?: string | null }> }) | null;
  passSubmitter?: {
    id?: string | null;
    username?: string | null;
    nickname?: string | null;
    playerId?: number | null;
  } | null;
  level?: {
    id?: number | null;
    song?: string | null;
    artist?: string | null;
    suffix?: string | null;
    diffId?: number | null;
    difficulty?: { name?: string | null; sortOrder?: number | null } | null;
    aliases?: Array<{ alias?: string | null }>;
  } | null;
};

type LevelIndexRow = {
  id: number;
  isLocked?: boolean | number | null;
  createdAt: Date | string;
  userId?: string | null;
  song?: string | null;
  artist?: string | null;
  charter?: string | null;
  vfxer?: string | null;
  team?: string | null;
  suffix?: string | null;
  diff?: string | null;
  songId?: number | null;
  artistId?: number | null;
  teamId?: number | null;
  songObject?: (NamedId & { aliases?: Array<{ alias?: string | null }> }) | null;
  artistObject?: (NamedId & { aliases?: Array<{ alias?: string | null }> }) | null;
  songRequest?: {
    songId?: number | null;
    songName?: string | null;
    song?: (NamedId & { aliases?: Array<{ alias?: string | null }> }) | null;
  } | null;
  artistRequests?: Array<{
    artistId?: number | null;
    artistName?: string | null;
    artist?: (NamedId & { aliases?: Array<{ alias?: string | null }> }) | null;
  }>;
  creatorRequests?: Array<{
    creatorId?: number | null;
    creatorName?: string | null;
    creator?: (NamedId & { creatorAliases?: Array<{ name?: string | null }> }) | null;
  }>;
  teamRequestData?: {
    teamId?: number | null;
    teamName?: string | null;
    team?: (NamedId & { teamAliases?: Array<{ name?: string | null }> }) | null;
  } | null;
  levelSubmitter?: {
    id?: string | null;
    username?: string | null;
    nickname?: string | null;
    playerId?: number | null;
  } | null;
};

async function fetchPasserNames(playerIds: Array<number | null | undefined>): Promise<Map<number, { name: string; aliases: string[] }>> {
  const unique = uniquePositiveIds(playerIds);
  const names = new Map<number, { name: string; aliases: string[] }>();
  if (unique.length === 0) return names;
  const players = await Player.findAll({
    where: { id: { [Op.in]: unique } },
    attributes: ['id', 'name'],
    include: [{ model: PlayerAlias, as: 'playerAliases', attributes: ['name'], required: false }],
  });
  for (const player of players) {
    const json = player.toJSON() as NamedId & { playerAliases?: Array<{ name?: string | null }> };
    names.set(player.id, {
      name: json.name || '',
      aliases: aliasNames(json.playerAliases),
    });
  }
  return names;
}

export async function fetchPassSubmissionQueueDocuments(
  ids: number[],
): Promise<SubmissionQueueIndexDocument[]> {
  const unique = uniquePositiveIds(ids);
  if (unique.length === 0) return [];
  const rows = await PassSubmission.findAll({
    where: { id: { [Op.in]: unique }, status: 'pending' },
    include: [
      {
        model: Player,
        as: 'assignedPlayer',
        required: false,
        attributes: ['id', 'name'],
        include: [{ model: PlayerAlias, as: 'playerAliases', attributes: ['name'], required: false }],
      },
      {
        model: User,
        as: 'passSubmitter',
        required: false,
        attributes: ['id', 'username', 'nickname', 'playerId'],
      },
      {
        model: Level,
        as: 'level',
        required: false,
        attributes: ['id', 'song', 'artist', 'suffix', 'diffId'],
        include: [
          { model: Difficulty, as: 'difficulty', attributes: ['name', 'sortOrder'], required: false },
          { model: LevelAlias, as: 'aliases', attributes: ['alias'], required: false },
        ],
      },
    ],
  });
  const typed = rows.map((row) => row.toJSON() as PassIndexRow);
  const passerNames = await fetchPasserNames(typed.map((row) => row.passerId ?? null));
  const ratios = await submitterRatioStats('pass', typed.map((row) => row.userId));

  return typed.map((row) => {
    const stats = row.userId ? ratios.get(row.userId) : undefined;
    const passer = row.passerId != null ? passerNames.get(row.passerId) : undefined;
    const difficultyName = row.level?.difficulty?.name ?? null;
    const sortOrder = Number(row.level?.difficulty?.sortOrder);
    return buildSubmissionQueueIndexDocument({
      kind: 'pass',
      id: row.id,
      isLocked: Boolean(row.isLocked),
      createdAt: row.createdAt,
      userId: row.userId ?? null,
      levelId: row.levelId ?? null,
      difficultySort: Number.isFinite(sortOrder) ? sortOrder : null,
      difficultySubtype: passDifficultySubtype(difficultyName),
      ratio: stats?.ratio ?? null,
      acceptedCount: stats?.accepted ?? 0,
      decidedCount: stats?.total ?? 0,
      creatorIds: [],
      playerIds: [row.passerId, row.assignedPlayerId, row.passSubmitter?.playerId],
      songIds: [],
      artistIds: [],
      teamIds: [],
      searchParts: [
        row.id,
        row.levelId,
        row.title,
        row.passer,
        row.feelingDifficulty,
        row.expectedDifficulty,
        passer?.name,
        ...(passer?.aliases || []),
        row.assignedPlayer?.name,
        ...aliasNames(row.assignedPlayer?.playerAliases),
        row.passSubmitter?.username,
        row.passSubmitter?.nickname,
        row.level?.song,
        row.level?.artist,
        row.level?.suffix,
        difficultyName,
        ...aliasNames(row.level?.aliases),
      ],
    });
  });
}

export async function fetchLevelSubmissionQueueDocuments(
  ids: number[],
): Promise<SubmissionQueueIndexDocument[]> {
  const unique = uniquePositiveIds(ids);
  if (unique.length === 0) return [];
  const rows = await LevelSubmission.findAll({
    where: { id: { [Op.in]: unique }, status: 'pending' },
    include: [
      {
        model: LevelSubmissionCreatorRequest,
        as: 'creatorRequests',
        required: false,
        attributes: ['creatorId', 'creatorName'],
        include: [{
          model: Creator,
          as: 'creator',
          required: false,
          attributes: ['id', 'name'],
          include: [{ model: CreatorAlias, as: 'creatorAliases', attributes: ['name'], required: false }],
        }],
      },
      {
        model: LevelSubmissionTeamRequest,
        as: 'teamRequestData',
        required: false,
        attributes: ['teamId', 'teamName'],
        include: [{
          model: Team,
          as: 'team',
          required: false,
          attributes: ['id', 'name'],
          include: [{ model: TeamAlias, as: 'teamAliases', attributes: ['name'], required: false }],
        }],
      },
      {
        model: LevelSubmissionSongRequest,
        as: 'songRequest',
        required: false,
        attributes: ['songId', 'songName'],
        include: [{
          model: Song,
          as: 'song',
          required: false,
          attributes: ['id', 'name'],
          include: [{ model: SongAlias, as: 'aliases', attributes: ['alias'], required: false }],
        }],
      },
      {
        model: LevelSubmissionArtistRequest,
        as: 'artistRequests',
        required: false,
        attributes: ['artistId', 'artistName'],
        include: [{
          model: Artist,
          as: 'artist',
          required: false,
          attributes: ['id', 'name'],
          include: [{ model: ArtistAlias, as: 'aliases', attributes: ['alias'], required: false }],
        }],
      },
      {
        model: Song,
        as: 'songObject',
        required: false,
        attributes: ['id', 'name'],
        include: [{ model: SongAlias, as: 'aliases', attributes: ['alias'], required: false }],
      },
      {
        model: Artist,
        as: 'artistObject',
        required: false,
        attributes: ['id', 'name'],
        include: [{ model: ArtistAlias, as: 'aliases', attributes: ['alias'], required: false }],
      },
      {
        model: User,
        as: 'levelSubmitter',
        required: false,
        attributes: ['id', 'username', 'nickname', 'playerId'],
      },
    ],
  });
  const typed = rows.map((row) => row.toJSON() as LevelIndexRow);
  const names = await difficultyNameOrders();
  const ratios = await submitterRatioStats('level', typed.map((row) => row.userId));

  return typed.map((row) => {
    const stats = row.userId ? ratios.get(row.userId) : undefined;
    const creatorIds = (row.creatorRequests || []).map((request) => request.creatorId);
    const artistIds = [
      row.artistId,
      row.artistObject?.id,
      ...(row.artistRequests || []).map((request) => request.artistId),
    ];
    const songIds = [row.songId, row.songObject?.id, row.songRequest?.songId, row.songRequest?.song?.id];
    const teamIds = [row.teamId, row.teamRequestData?.teamId, row.teamRequestData?.team?.id];
    return buildSubmissionQueueIndexDocument({
      kind: 'level',
      id: row.id,
      isLocked: Boolean(row.isLocked),
      createdAt: row.createdAt,
      userId: row.userId ?? null,
      levelId: null,
      difficultySort: difficultyTextSortValue(row.diff, names),
      difficultySubtype: passDifficultySubtype(row.diff),
      ratio: stats?.ratio ?? null,
      acceptedCount: stats?.accepted ?? 0,
      decidedCount: stats?.total ?? 0,
      creatorIds,
      playerIds: [row.levelSubmitter?.playerId],
      songIds,
      artistIds,
      teamIds,
      searchParts: [
        row.id,
        row.song,
        row.artist,
        row.charter,
        row.vfxer,
        row.team,
        row.suffix,
        row.diff,
        row.songObject?.name,
        ...aliasNames(row.songObject?.aliases),
        row.songRequest?.songName,
        row.songRequest?.song?.name,
        ...aliasNames(row.songRequest?.song?.aliases),
        row.artistObject?.name,
        ...aliasNames(row.artistObject?.aliases),
        ...(row.artistRequests || []).flatMap((request) => [
          request.artistName,
          request.artist?.name,
          ...aliasNames(request.artist?.aliases),
        ]),
        ...(row.creatorRequests || []).flatMap((request) => [
          request.creatorName,
          request.creator?.name,
          ...aliasNames(request.creator?.creatorAliases),
        ]),
        row.teamRequestData?.teamName,
        row.teamRequestData?.team?.name,
        ...aliasNames(row.teamRequestData?.team?.teamAliases),
        row.levelSubmitter?.username,
        row.levelSubmitter?.nickname,
      ],
    });
  });
}

export async function fetchSubmissionQueueDocuments(
  kind: SubmissionQueueKind,
  ids: number[],
): Promise<SubmissionQueueIndexDocument[]> {
  return kind === 'pass'
    ? fetchPassSubmissionQueueDocuments(ids)
    : fetchLevelSubmissionQueueDocuments(ids);
}

export async function listPendingSubmissionIds(
  kind: SubmissionQueueKind,
  afterId = 0,
  limit = 500,
): Promise<number[]> {
  const finder = (kind === 'pass' ? PassSubmission : LevelSubmission) as typeof LevelSubmission;
  const rows = await finder.findAll({
    where: { status: 'pending', id: { [Op.gt]: afterId } },
    attributes: ['id'],
    order: [['id', 'ASC']],
    limit,
    raw: true,
  }) as unknown as Array<{ id: number }>;
  return rows.map((row) => row.id);
}
