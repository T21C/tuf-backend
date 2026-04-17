import { CDN_CONFIG } from '@/externalServices/cdnService/config.js';

import { cleanVideoUrl } from '../shared/videoUrl.js';
import { sanitizeTextInput } from '../shared/sanitize.js';
import { safeParseJSON } from '../shared/json.js';
import { validateCreatorRequest, validateTeamRequest } from '../shared/validators.js';
import type { CreatorRequestLike, TeamRequestLike } from '../shared/validators.js';

/**
 * Shape of the normalised level submission payload that both `/validate` and
 * `/submit` work against. Producing this is pure: no DB, no I/O.
 */
export interface LevelFormSanitised {
  artist: string;
  song: string;
  suffix: string | null;
  diff: string;
  videoLink: string;
  directDL: string;
  wsLink: string;
  songId: number | null;
  artistId: number | null;
  isNewSongRequest: boolean;
  isNewArtistRequest: boolean;
  creatorRequests: CreatorRequestLike[];
  teamRequest: TeamRequestLike | null;
  artistRequests: Array<{
    artistId: number | null;
    artistName: string | null;
    isNewRequest: boolean;
    verificationState: string | null;
  }>;
  evidenceType: 'song' | 'artist';
}

export interface ParsedLevelForm {
  sanitized: LevelFormSanitised;
  errors: Array<{ field: string; message: string }>;
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true';
}

function parsePositiveIntOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = parseInt(String(value));
  if (Number.isNaN(n) || n <= 0) return null;
  return n;
}

/**
 * Pure: turns raw req.body into a normalised payload + a list of structural
 * errors. Does not hit the database. Callers are expected to follow up with
 * referenceCheck / duplicateCheck if the errors list is empty.
 */
export function parseAndSanitizeLevelForm(body: Record<string, unknown>): ParsedLevelForm {
  const errors: Array<{ field: string; message: string }> = [];

  const requiredText = (field: string): string => {
    const raw = body[field];
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      errors.push({ field, message: `Missing or invalid required field: ${field}` });
      return '';
    }
    return raw.trim();
  };

  const artist = sanitizeTextInput(requiredText('artist'));
  const song = sanitizeTextInput(requiredText('song'));
  const diff = sanitizeTextInput(requiredText('diff'));
  const videoLinkRaw = requiredText('videoLink');
  const videoLink = videoLinkRaw ? cleanVideoUrl(videoLinkRaw) : '';

  const directDLRaw = typeof body.directDL === 'string' ? body.directDL : '';
  if (directDLRaw && directDLRaw.startsWith(CDN_CONFIG.baseUrl)) {
    errors.push({ field: 'directDL', message: 'Direct download cannot point to local CDN' });
  }
  const directDL = sanitizeTextInput(directDLRaw);
  const wsLink = sanitizeTextInput(typeof body.wsLink === 'string' ? body.wsLink : '');

  const suffixRaw = typeof body.suffix === 'string' ? body.suffix : '';
  const suffix = suffixRaw ? sanitizeTextInput(suffixRaw).trim() || null : null;

  const isNewSongRequest = asBool(body.isNewSongRequest);
  const isNewArtistRequest = asBool(body.isNewArtistRequest);
  const songId = isNewSongRequest ? null : parsePositiveIntOrNull(body.songId);
  const artistId = isNewArtistRequest ? null : parsePositiveIntOrNull(body.artistId);

  const creatorRequestsRaw = safeParseJSON<unknown>(body.creatorRequests as string | object | null | undefined);
  const creatorRequests: CreatorRequestLike[] = Array.isArray(creatorRequestsRaw)
    ? creatorRequestsRaw.filter(validateCreatorRequest).map((r) => ({
        creatorName: sanitizeTextInput(r.creatorName),
        role: sanitizeTextInput(r.role),
        creatorId: r.creatorId ?? null,
        isNewRequest: r.isNewRequest ?? false,
      }))
    : [];

  const teamRequestRaw = safeParseJSON<unknown>(body.teamRequest as string | object | null | undefined);
  const teamRequest: TeamRequestLike | null =
    teamRequestRaw && validateTeamRequest(teamRequestRaw)
      ? {
          teamName: sanitizeTextInput(teamRequestRaw.teamName),
          teamId: teamRequestRaw.teamId ?? null,
          isNewRequest: teamRequestRaw.isNewRequest ?? false,
        }
      : null;

  const artistRequestsRaw = safeParseJSON<unknown>(body.artistRequests as string | object | null | undefined);
  const artistRequests: LevelFormSanitised['artistRequests'] = Array.isArray(artistRequestsRaw)
    ? artistRequestsRaw.map((r) => {
        const row = (r ?? {}) as Record<string, unknown>;
        return {
          artistId: parsePositiveIntOrNull(row.artistId),
          artistName:
            typeof row.artistName === 'string' && row.artistName.trim().length > 0
              ? sanitizeTextInput(row.artistName)
              : null,
          isNewRequest: asBool(row.isNewRequest),
          verificationState:
            typeof row.verificationState === 'string' && row.verificationState.trim().length > 0
              ? row.verificationState
              : null,
        };
      })
    : [];

  const evidenceTypeRaw = typeof body.evidenceType === 'string' ? body.evidenceType : 'song';
  const evidenceType: 'song' | 'artist' = evidenceTypeRaw === 'artist' ? 'artist' : 'song';

  const sanitized: LevelFormSanitised = {
    artist,
    song,
    suffix,
    diff,
    videoLink,
    directDL,
    wsLink,
    songId,
    artistId,
    isNewSongRequest,
    isNewArtistRequest,
    creatorRequests,
    teamRequest,
    artistRequests,
    evidenceType,
  };

  return { sanitized, errors };
}
