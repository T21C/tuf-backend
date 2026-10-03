export type SubmitterSearchFields = {
  username?: string | null;
  nickname?: string | null;
  playerId?: number | null;
};

export type LevelSubmissionSearchRow = {
  id: number;
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
  songObject?: {id?: number | null; name?: string | null} | null;
  artistObject?: {id?: number | null; name?: string | null} | null;
  songRequest?: {songId?: number | null; songName?: string | null; song?: {name?: string | null} | null} | null;
  artistRequests?: Array<{artistId?: number | null; artistName?: string | null; artist?: {name?: string | null} | null}>;
  creatorRequests?: Array<{creatorId?: number | null; creatorName?: string | null}>;
  teamRequestData?: {teamId?: number | null; teamName?: string | null; team?: {name?: string | null} | null} | null;
  levelSubmitter?: SubmitterSearchFields | null;
};

export type PassSubmissionSearchRow = {
  id: number;
  title?: string | null;
  passer?: string | null;
  passerId?: number | null;
  assignedPlayerId?: number | null;
  levelId?: number | null;
  feelingDifficulty?: string | null;
  expectedDifficulty?: string | null;
  assignedPlayer?: {id?: number | null; name?: string | null} | null;
  passSubmitter?: SubmitterSearchFields | null;
};

export type LevelSubmissionSearchLookups = {
  creatorIds: Set<number>;
  playerIds: Set<number>;
  songIds: Set<number>;
  artistIds: Set<number>;
  teamIds: Set<number>;
};

export type PassSubmissionSearchLookups = {
  levelIds: Set<number>;
  playerIds: Set<number>;
};

const QUERY_MAX_LEN = 255;

export function normalizeSubmissionSearchQuery(raw: string | null | undefined): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  return trimmed.length > QUERY_MAX_LEN ? trimmed.slice(0, QUERY_MAX_LEN) : trimmed;
}

export function uniquePositiveIds(values: Array<number | null | undefined>): number[] {
  return [...new Set(values.filter((id): id is number => Number.isFinite(id) && (id as number) > 0))];
}

export function haystackIncludes(query: string, values: unknown[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return values.some((value) => value != null && String(value).toLowerCase().includes(q));
}

function submitterHaystack(submitter: SubmitterSearchFields | null | undefined): unknown[] {
  if (!submitter) return [];
  return [submitter.username, submitter.nickname, submitter.playerId];
}

export function emptyLevelLookups(): LevelSubmissionSearchLookups {
  return {
    creatorIds: new Set(),
    playerIds: new Set(),
    songIds: new Set(),
    artistIds: new Set(),
    teamIds: new Set(),
  };
}

export function emptyPassLookups(): PassSubmissionSearchLookups {
  return {
    levelIds: new Set(),
    playerIds: new Set(),
  };
}

export function levelSubmissionMatchesSearch(
  row: LevelSubmissionSearchRow,
  query: string,
  lookups: LevelSubmissionSearchLookups,
): boolean {
  const q = normalizeSubmissionSearchQuery(query);
  if (!q) return true;

  if (lookups.playerIds.has(row.levelSubmitter?.playerId ?? 0)) return true;
  if (lookups.songIds.has(row.songId ?? 0) || lookups.songIds.has(row.songRequest?.songId ?? 0)) return true;
  if (lookups.artistIds.has(row.artistId ?? 0)) return true;
  if (lookups.teamIds.has(row.teamId ?? 0) || lookups.teamIds.has(row.teamRequestData?.teamId ?? 0)) return true;
  if ((row.creatorRequests || []).some((request) => lookups.creatorIds.has(request.creatorId ?? 0))) return true;
  if ((row.artistRequests || []).some((request) => lookups.artistIds.has(request.artistId ?? 0))) return true;

  return haystackIncludes(q, [
    row.id,
    row.song,
    row.songObject?.name,
    row.songRequest?.songName,
    row.songRequest?.song?.name,
    row.artist,
    row.artistObject?.name,
    ...(row.artistRequests || []).flatMap((request) => [request.artistName, request.artist?.name]),
    row.charter,
    row.vfxer,
    row.team,
    row.teamRequestData?.teamName,
    row.teamRequestData?.team?.name,
    ...(row.creatorRequests || []).map((request) => request.creatorName),
    row.suffix,
    row.diff,
    ...submitterHaystack(row.levelSubmitter),
  ]);
}

export function passSubmissionMatchesSearch(
  row: PassSubmissionSearchRow,
  query: string,
  lookups: PassSubmissionSearchLookups,
): boolean {
  const q = normalizeSubmissionSearchQuery(query);
  if (!q) return true;

  if (lookups.levelIds.has(row.levelId ?? 0)) return true;
  if (lookups.playerIds.has(row.passerId ?? 0) || lookups.playerIds.has(row.assignedPlayerId ?? 0)) return true;

  return haystackIncludes(q, [
    row.id,
    row.title,
    row.passer,
    row.assignedPlayer?.name,
    row.feelingDifficulty,
    row.expectedDifficulty,
    ...submitterHaystack(row.passSubmitter),
  ]);
}
