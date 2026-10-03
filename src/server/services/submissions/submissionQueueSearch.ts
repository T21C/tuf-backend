import {Op} from 'sequelize';
import {logger} from '@/server/services/core/LoggerService.js';
import {escapeForMySQL} from '@/misc/utils/data/searchHelpers.js';
import LevelSubmission from '@/models/submissions/LevelSubmission.js';
import LevelSubmissionCreatorRequest from '@/models/submissions/LevelSubmissionCreatorRequest.js';
import LevelSubmissionArtistRequest from '@/models/submissions/LevelSubmissionArtistRequest.js';
import LevelSubmissionSongRequest from '@/models/submissions/LevelSubmissionSongRequest.js';
import LevelSubmissionTeamRequest from '@/models/submissions/LevelSubmissionTeamRequest.js';
import {PassSubmission} from '@/models/submissions/PassSubmission.js';
import User from '@/models/auth/User.js';
import Player from '@/models/players/Player.js';
import Song from '@/models/songs/Song.js';
import SongAlias from '@/models/songs/SongAlias.js';
import Artist from '@/models/artists/Artist.js';
import ArtistAlias from '@/models/artists/ArtistAlias.js';
import Team from '@/models/credits/Team.js';
import {TeamAlias} from '@/models/credits/TeamAlias.js';
import {searchLevelIdsInSet} from '@/server/services/elasticsearch/search/levels/levelSearch.js';
import {searchPlayerIdsInSet} from '@/server/services/elasticsearch/search/players/playerSearch.js';
import {searchCreatorIdsInSet} from '@/server/services/elasticsearch/search/creators/creatorSearch.js';
import {
  type LevelSubmissionSearchLookups,
  type LevelSubmissionSearchRow,
  type PassSubmissionSearchLookups,
  type PassSubmissionSearchRow,
  levelSubmissionMatchesSearch,
  normalizeSubmissionSearchQuery,
  passSubmissionMatchesSearch,
  uniquePositiveIds,
} from './submissionQueueSearchMatch.js';

export {
  haystackIncludes,
  levelSubmissionMatchesSearch,
  normalizeSubmissionSearchQuery,
  passSubmissionMatchesSearch,
  uniquePositiveIds,
} from './submissionQueueSearchMatch.js';

async function safeEsIds(
  label: string,
  run: () => Promise<number[]>,
): Promise<number[]> {
  try {
    return await run();
  } catch (error) {
    logger.error(`submission queue search ${label} failed:`, error);
    return [];
  }
}

async function idsMatchingNameOrAlias(params: {
  ids: number[];
  like: string;
  findByName: (ids: number[], like: string) => Promise<Array<{id: number}>>;
  findByAlias: (ids: number[], like: string) => Promise<number[]>;
}): Promise<Set<number>> {
  if (params.ids.length === 0) return new Set();
  const [named, aliased] = await Promise.all([
    params.findByName(params.ids, params.like),
    params.findByAlias(params.ids, params.like),
  ]);
  return new Set([...named.map((row) => row.id), ...aliased]);
}

function likePattern(query: string): string {
  return `%${escapeForMySQL(query)}%`;
}

export async function searchPendingLevelSubmissionIds(rawQuery: string): Promise<number[]> {
  const query = normalizeSubmissionSearchQuery(rawQuery);
  const rows = await LevelSubmission.findAll({
    where: {status: 'pending'},
    attributes: ['id', 'song', 'artist', 'charter', 'vfxer', 'team', 'suffix', 'diff', 'songId', 'artistId', 'teamId'],
    include: [
      {model: LevelSubmissionCreatorRequest, as: 'creatorRequests', attributes: ['creatorId', 'creatorName']},
      {model: LevelSubmissionArtistRequest, as: 'artistRequests', attributes: ['artistId', 'artistName']},
      {model: LevelSubmissionSongRequest, as: 'songRequest', attributes: ['songId', 'songName']},
      {model: LevelSubmissionTeamRequest, as: 'teamRequestData', attributes: ['teamId', 'teamName']},
      {model: User, as: 'levelSubmitter', required: false, attributes: ['username', 'nickname', 'playerId']},
      {model: Song, as: 'songObject', required: false, attributes: ['id', 'name']},
      {model: Artist, as: 'artistObject', required: false, attributes: ['id', 'name']},
    ],
  });
  const typed = rows as unknown as LevelSubmissionSearchRow[];
  if (!query) return typed.map((row) => row.id);

  const creatorIds = uniquePositiveIds(
    typed.flatMap((row) => (row.creatorRequests || []).map((request) => request.creatorId)),
  );
  const playerIds = uniquePositiveIds(typed.map((row) => row.levelSubmitter?.playerId));
  const songIds = uniquePositiveIds(
    typed.flatMap((row) => [row.songId, row.songRequest?.songId, row.songObject?.id]),
  );
  const artistIds = uniquePositiveIds(
    typed.flatMap((row) => [
      row.artistId,
      row.artistObject?.id,
      ...(row.artistRequests || []).map((request) => request.artistId),
    ]),
  );
  const teamIds = uniquePositiveIds(
    typed.flatMap((row) => [row.teamId, row.teamRequestData?.teamId]),
  );

  const like = likePattern(query);
  const [esCreators, esPlayers, dbSongs, dbArtists, dbTeams] = await Promise.all([
    safeEsIds('creators', () => searchCreatorIdsInSet(query, creatorIds)),
    safeEsIds('players', () => searchPlayerIdsInSet(query, playerIds)),
    idsMatchingNameOrAlias({
      ids: songIds,
      like,
      findByName: (ids, pattern) => Song.findAll({
        where: {id: {[Op.in]: ids}, name: {[Op.like]: pattern}},
        attributes: ['id'],
      }),
      findByAlias: async (ids, pattern) => {
        const aliases = await SongAlias.findAll({
          where: {songId: {[Op.in]: ids}, alias: {[Op.like]: pattern}},
          attributes: ['songId'],
        });
        return aliases.map((row) => row.songId);
      },
    }),
    idsMatchingNameOrAlias({
      ids: artistIds,
      like,
      findByName: (ids, pattern) => Artist.findAll({
        where: {id: {[Op.in]: ids}, name: {[Op.like]: pattern}},
        attributes: ['id'],
      }),
      findByAlias: async (ids, pattern) => {
        const aliases = await ArtistAlias.findAll({
          where: {artistId: {[Op.in]: ids}, alias: {[Op.like]: pattern}},
          attributes: ['artistId'],
        });
        return aliases.map((row) => row.artistId);
      },
    }),
    idsMatchingNameOrAlias({
      ids: teamIds,
      like,
      findByName: (ids, pattern) => Team.findAll({
        where: {id: {[Op.in]: ids}, name: {[Op.like]: pattern}},
        attributes: ['id'],
      }),
      findByAlias: async (ids, pattern) => {
        const aliases = await TeamAlias.findAll({
          where: {teamId: {[Op.in]: ids}, name: {[Op.like]: pattern}},
          attributes: ['teamId'],
        });
        return aliases.map((row) => row.teamId);
      },
    }),
  ]);

  const lookups: LevelSubmissionSearchLookups = {
    creatorIds: new Set(esCreators),
    playerIds: new Set(esPlayers),
    songIds: dbSongs,
    artistIds: dbArtists,
    teamIds: dbTeams,
  };

  return typed
    .filter((row) => levelSubmissionMatchesSearch(row, query, lookups))
    .map((row) => row.id);
}

export async function searchPendingPassSubmissionIds(rawQuery: string): Promise<number[]> {
  const query = normalizeSubmissionSearchQuery(rawQuery);
  const rows = await PassSubmission.findAll({
    where: {status: 'pending'},
    attributes: ['id', 'title', 'passer', 'passerId', 'assignedPlayerId', 'levelId', 'feelingDifficulty', 'expectedDifficulty'],
    include: [
      {model: User, as: 'passSubmitter', required: false, attributes: ['username', 'nickname', 'playerId']},
      {model: Player, as: 'assignedPlayer', required: false, attributes: ['id', 'name']},
    ],
  });
  const typed = rows as unknown as PassSubmissionSearchRow[];
  if (!query) return typed.map((row) => row.id);

  const levelIds = uniquePositiveIds(typed.map((row) => row.levelId));
  const playerIds = uniquePositiveIds(
    typed.flatMap((row) => [row.passerId, row.assignedPlayerId, row.passSubmitter?.playerId]),
  );

  const [esLevels, esPlayers] = await Promise.all([
    safeEsIds('levels', () => searchLevelIdsInSet(query, levelIds, {requireToRate: false})),
    safeEsIds('players', () => searchPlayerIdsInSet(query, playerIds)),
  ]);

  const lookups: PassSubmissionSearchLookups = {
    levelIds: new Set(esLevels),
    playerIds: new Set(esPlayers),
  };

  return typed
    .filter((row) => passSubmissionMatchesSearch(row, query, lookups))
    .map((row) => row.id);
}
