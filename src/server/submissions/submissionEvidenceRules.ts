import type {Transaction} from 'sequelize';
import Song from '@/models/songs/Song.js';
import Artist from '@/models/artists/Artist.js';

/** Song DB states where a linked song does not require submission evidence. */
export const SONG_VERIFICATION_NO_EVIDENCE = new Set<string>(['ysmod_only', 'allowed', 'tuf_verified']);

/**
 * Artist DB states where a new artist request (with existing artist id) does not require evidence.
 */
export const ARTIST_VERIFICATION_NO_EVIDENCE = new Set<string>([
  'ysmod_only',
  'allowed',
  'mostly_allowed',
  'tuf_verified',
]);

/**
 * Established artists in this lineup waive **song** evidence for new song requests
 * when every established artist is in this set (trusted for songs by default).
 */
export const ARTIST_LINEUP_WAIVES_SONG_EVIDENCE = new Set<string>(['allowed', 'mostly_allowed']);

export function normalizeVerificationState(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim().toLowerCase();
  return t.length > 0 ? t : null;
}

export function songStateDoesNotRequireEvidence(state: string | null | undefined): boolean {
  const n = normalizeVerificationState(state);
  return n !== null && SONG_VERIFICATION_NO_EVIDENCE.has(n);
}

export function artistStateDoesNotRequireEvidence(state: string | null | undefined): boolean {
  const n = normalizeVerificationState(state);
  return n !== null && ARTIST_VERIFICATION_NO_EVIDENCE.has(n);
}

export function artistLineupWaivesSongEvidence(
  establishedStates: Array<string | null | undefined>
): boolean {
  if (establishedStates.length === 0) return false;
  return establishedStates.every((s) => {
    const n = normalizeVerificationState(s);
    return n !== null && ARTIST_LINEUP_WAIVES_SONG_EVIDENCE.has(n);
  });
}

function parsePositiveInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : parseInt(String(value), 10);
  if (Number.isNaN(n) || n <= 0) return null;
  return n;
}

function isTruthyBool(value: unknown): boolean {
  return value === true || value === 'true';
}

export type SubmissionEvidenceBodyLike = {
  isNewSongRequest: boolean | string;
  songId?: string | number | null;
  isNewArtistRequest: boolean | string;
  artistId?: string | number | null;
};

/**
 * Server-only evidence requirements. Uses DB verification for any submitted artist/song id.
 */
export async function computeSubmissionEvidenceRequirements(
  body: SubmissionEvidenceBodyLike,
  parsedArtistRequests: unknown,
  transaction: Transaction
): Promise<{requiresSongEvidence: boolean; requiresArtistEvidence: boolean}> {
  const isNewSongRequest = body.isNewSongRequest === true || body.isNewSongRequest === 'true';
  const isNewArtistRequest = body.isNewArtistRequest === true || body.isNewArtistRequest === 'true';

  const optionalSongIdWhenNew = isNewSongRequest ? parsePositiveInt(body.songId) : null;

  const requests = Array.isArray(parsedArtistRequests) ? parsedArtistRequests : [];

  const establishedArtistIds = new Set<number>();
  const newRequestArtistIds = new Set<number>();

  for (const r of requests) {
    const aid = parsePositiveInt((r as any)?.artistId);
    const isNew = isTruthyBool((r as any)?.isNewRequest);
    if (aid && !isNew) establishedArtistIds.add(aid);
    if (isNew && aid) newRequestArtistIds.add(aid);
    if (isNew && !aid) {
      /* new name only — handled below without DB */
    }
  }

  const legacyArtistId = parsePositiveInt(body.artistId);
  if (requests.length === 0) {
    if (!isNewArtistRequest && legacyArtistId) {
      establishedArtistIds.add(legacyArtistId);
    }
    if (isNewArtistRequest && legacyArtistId) {
      newRequestArtistIds.add(legacyArtistId);
    }
  }

  const allArtistIds = [...new Set([...establishedArtistIds, ...newRequestArtistIds])];
  const artistRows =
    allArtistIds.length > 0
      ? await Artist.findAll({
          where: {id: allArtistIds},
          attributes: ['id', 'verificationState'],
          transaction,
        })
      : [];
  const artistStateById = new Map<number, string>();
  for (const row of artistRows) {
    artistStateById.set(row.id, row.verificationState);
  }

  let requiresSongEvidence = false;
  if (isNewSongRequest) {
    let waiveBySongDb = false;
    if (optionalSongIdWhenNew) {
      const song = await Song.findByPk(optionalSongIdWhenNew, {
        attributes: ['verificationState'],
        transaction,
      });
      if (song) {
        waiveBySongDb = songStateDoesNotRequireEvidence(song.verificationState);
      }
    }

    const establishedStates: Array<string | null | undefined> = [];
    for (const id of establishedArtistIds) {
      establishedStates.push(artistStateById.get(id) ?? null);
    }
    const waiveByLineup = artistLineupWaivesSongEvidence(establishedStates);

    requiresSongEvidence = !(waiveBySongDb || waiveByLineup);
  }

  let requiresArtistEvidence = false;

  if (requests.length > 0) {
    for (const r of requests) {
      const isNew = isTruthyBool((r as any)?.isNewRequest);
      if (!isNew) continue;
      const aid = parsePositiveInt((r as any)?.artistId);
      if (!aid) {
        requiresArtistEvidence = true;
        break;
      }
      const st = artistStateById.get(aid);
      if (!artistStateDoesNotRequireEvidence(st)) {
        requiresArtistEvidence = true;
        break;
      }
    }
  } else if (isNewArtistRequest) {
    if (!legacyArtistId) {
      requiresArtistEvidence = true;
    } else {
      const st = artistStateById.get(legacyArtistId);
      requiresArtistEvidence = !artistStateDoesNotRequireEvidence(st);
    }
  }

  return {requiresSongEvidence, requiresArtistEvidence};
}
