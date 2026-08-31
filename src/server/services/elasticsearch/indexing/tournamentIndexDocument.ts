export type TournamentIndexPerson = {
  id: number;
  name: string;
};

export type TournamentIndexLevel = {
  id: number;
  song: string | null;
  artist: string | null;
};

export type TournamentIndexPlacement = {
  displayName: string;
  teamName: string | null;
  player: TournamentIndexPerson | null;
  creator: TournamentIndexPerson | null;
  level: TournamentIndexLevel | null;
  creditPlayers: TournamentIndexPerson[];
  creditCreators: TournamentIndexPerson[];
};

export type TournamentIndexInput = {
  id: number;
  shortName: string;
  fullName?: string | null;
  aka?: string | null;
  notes?: string | null;
  status: string;
  isHidden?: boolean | null;
  isResultsFinal?: boolean | null;
  track?: string | null;
  seriesId?: number | null;
  series?: {
    id?: number;
    slug?: string | null;
    name?: string | null;
    sortWeight?: number | null;
  } | null;
  sortYear?: number | null;
  sortWeight?: number | null;
  startsAt?: string | Date | null;
  endsAt?: string | Date | null;
  packRef?: string | null;
  iconUrl?: string | null;
  organizers?: string[] | null;
  placements?: TournamentIndexPlacement[] | null;
};

export type TournamentIndexDocument = {
  id: number;
  shortName: string;
  fullName: string | null;
  aka: string | null;
  status: string;
  isHidden: boolean;
  isResultsFinal: boolean;
  track: string;
  seriesId: number | null;
  seriesName: string | null;
  seriesSlug: string | null;
  seriesSortWeight: number;
  sortYear: number | null;
  sortWeight: number;
  startsAt: string | Date | null;
  endsAt: string | Date | null;
  packRef: string | null;
  iconUrl: string | null;
  organizers: string[];
  searchText: string;
};

const UNSERIESED_SORT_WEIGHT = 100;

function personBits(person: TournamentIndexPerson | null | undefined): string[] {
  if (!person?.name) return [];
  return [person.name];
}

function levelBits(level: TournamentIndexLevel | null | undefined): string[] {
  if (!level) return [];
  return [level.song, level.artist].filter((value): value is string => Boolean(value));
}

export function buildTournamentSearchText(tournament: TournamentIndexInput): string {
  const organizers = Array.isArray(tournament.organizers) ? tournament.organizers : [];
  const placements = Array.isArray(tournament.placements) ? tournament.placements : [];
  const placementBits = placements.flatMap(placement => [
    placement.displayName,
    placement.teamName,
    ...personBits(placement.player),
    ...personBits(placement.creator),
    ...levelBits(placement.level),
    ...placement.creditPlayers.flatMap(personBits),
    ...placement.creditCreators.flatMap(personBits),
  ]);

  return [
    tournament.shortName,
    tournament.fullName,
    tournament.aka,
    tournament.notes,
    tournament.series?.name,
    tournament.series?.slug,
    tournament.packRef,
    ...organizers,
    ...placementBits,
  ]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join('\n');
}

export function buildTournamentIndexDocument(tournament: TournamentIndexInput): TournamentIndexDocument {
  const series = tournament.series ?? null;
  return {
    id: tournament.id,
    shortName: tournament.shortName,
    fullName: tournament.fullName ?? null,
    aka: tournament.aka ?? null,
    status: tournament.status,
    isHidden: Boolean(tournament.isHidden),
    isResultsFinal: Boolean(tournament.isResultsFinal),
    track: tournament.track === 'creator' ? 'creator' : 'player',
    seriesId: tournament.seriesId ?? series?.id ?? null,
    seriesName: series?.name ?? null,
    seriesSlug: series?.slug ?? null,
    seriesSortWeight: series?.sortWeight ?? UNSERIESED_SORT_WEIGHT,
    sortYear: tournament.sortYear ?? null,
    sortWeight: tournament.sortWeight ?? 0,
    startsAt: tournament.startsAt ?? null,
    endsAt: tournament.endsAt ?? null,
    packRef: tournament.packRef ?? null,
    iconUrl: tournament.iconUrl ?? null,
    organizers: Array.isArray(tournament.organizers) ? tournament.organizers.map(String) : [],
    searchText: buildTournamentSearchText(tournament),
  };
}

function namedPerson(value: unknown): TournamentIndexPerson | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as {id?: unknown; name?: unknown};
  const id = Number(row.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return {id, name: String(row.name || '')};
}

export function placementsFromIndexSource(rawPlacements: unknown): TournamentIndexPlacement[] {
  if (!Array.isArray(rawPlacements)) return [];
  return rawPlacements.map(item => {
    const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const credits = Array.isArray(row.credits) ? row.credits : [];
    return {
      displayName: String(row.displayName || ''),
      teamName: row.teamName == null ? null : String(row.teamName),
      player: namedPerson(row.player),
      creator: namedPerson(row.creator),
      level:
        row.level && typeof row.level === 'object'
          ? {
              id: Number((row.level as {id?: unknown}).id) || 0,
              song: ((row.level as {song?: unknown}).song as string | null) ?? null,
              artist: ((row.level as {artist?: unknown}).artist as string | null) ?? null,
            }
          : null,
      creditPlayers: credits
        .map(credit => namedPerson((credit as {player?: unknown})?.player))
        .filter((person): person is TournamentIndexPerson => Boolean(person)),
      creditCreators: credits
        .map(credit => namedPerson((credit as {creator?: unknown})?.creator))
        .filter((person): person is TournamentIndexPerson => Boolean(person)),
    };
  });
}
