import axios from 'axios';
import {Op} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import {coalesceAxiosContentTypeHeader} from '@/misc/utils/http/axiosContentType.js';
import Artist from '@/models/artists/Artist.js';
import ArtistAlias from '@/models/artists/ArtistAlias.js';
import ArtistEvidence from '@/models/artists/ArtistEvidence.js';
import ArtistLink from '@/models/artists/ArtistLink.js';
import type {ArtistVerificationState} from '@/models/verificationStates.js';
import {logger} from '@/server/services/core/LoggerService.js';
import cdnServiceInstance from '@/server/services/core/CdnService.js';
import {
  ARTIST_VERIFICATION_SYNC_ACTION,
  decideArtistVerificationSync,
  feedMatchNames,
  isEvidenceImageUrl,
  localVerificationState,
  matchArtistIds,
  parseArtistFeedRow,
  rememberArtistKeys,
  type ArtistSyncIndex,
  type ArtistSyncMatch,
  type ParsedArtistFeedRow,
  type SourceAlignedArtistState,
} from './artistVerificationSyncDecision.js';

export const DEFAULT_ARTIST_VERIFICATION_URL = 'https://7thbe.at/wapi/getArtists';
const FETCH_TIMEOUT_MS = 60_000;
const IMAGE_TIMEOUT_MS = 45_000;

const sequelize = getSequelizeForModelGroup('levels');

export type ArtistVerificationSyncResult = {
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  skippedUnaligned: number;
  skippedProtected: number;
  skippedAmbiguous: number;
  errors: number;
  alreadyRunning: boolean;
};

type ArtistVerificationSyncCounts = Omit<ArtistVerificationSyncResult, 'alreadyRunning'>;

type IndexedArtist = {
  verificationState: ArtistVerificationState;
  extraInfo: string | null;
};

function emptyCounts(): ArtistVerificationSyncCounts {
  return {
    fetched: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skippedUnaligned: 0,
    skippedProtected: 0,
    skippedAmbiguous: 0,
    errors: 0,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 500);
  return 'Unknown error';
}

export function artistVerificationFeedUrl(): string {
  const raw = process.env.ARTIST_VERIFICATION_URL?.trim();
  return raw || DEFAULT_ARTIST_VERIFICATION_URL;
}

function readFeedArtists(data: unknown): unknown[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Artist verification feed was not a JSON object');
  }
  const body = data as {result?: unknown; artists?: unknown};
  if (body.result !== 1 || !Array.isArray(body.artists)) {
    throw new Error('Artist verification feed was not a valid artist list');
  }
  if (body.artists.length === 0) {
    throw new Error('Artist verification feed was empty');
  }
  return body.artists;
}

async function fetchArtistFeed(url: string): Promise<unknown[]> {
  const response = await axios.get(url, {
    timeout: FETCH_TIMEOUT_MS,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'TUF-Website/artist-verification-sync',
    },
    validateStatus: (status) => status >= 200 && status < 300,
  });
  return readFeedArtists(response.data);
}

async function downloadEvidenceImage(url: string): Promise<Buffer | null> {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: IMAGE_TIMEOUT_MS,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 400,
      headers: {
        Accept: 'image/*',
        'User-Agent': 'TUF-Website/artist-verification-sync',
      },
    });
    const contentType = coalesceAxiosContentTypeHeader(response.headers['content-type']) ?? '';
    if (!contentType.startsWith('image/')) return null;
    return Buffer.from(response.data);
  } catch (error) {
    logger.warn('Artist verification evidence download failed', {url, error: errorMessage(error)});
    return null;
  }
}

async function storeEvidenceImage(url: string): Promise<string> {
  const image = await downloadEvidenceImage(url);
  if (!image) return url;
  const filename = url.split('/').pop()?.split('?')[0] || `evidence_${Date.now()}.png`;
  try {
    const uploaded = await cdnServiceInstance.uploadImage(image, filename, 'EVIDENCE');
    const stored = uploaded.urls?.original;
    return typeof stored === 'string' && stored.trim() ? stored : url;
  } catch (error) {
    logger.warn('Artist verification evidence upload failed', {url, error: errorMessage(error)});
    return url;
  }
}

async function resolveEvidenceLinks(urls: string[]): Promise<string[]> {
  const resolved: string[] = [];
  const seen = new Set<string>();
  const downloads = urls.map(async (url) => {
    if (!isEvidenceImageUrl(url)) return url;
    return storeEvidenceImage(url);
  });
  const results = await Promise.allSettled(downloads);
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    const link = result.status === 'fulfilled' ? result.value : urls[i];
    if (!link || seen.has(link)) continue;
    seen.add(link);
    resolved.push(link);
  }
  return resolved;
}

async function createArtistFromFeed(
  row: ParsedArtistFeedRow,
  verificationState: SourceAlignedArtistState,
): Promise<number> {
  const evidenceLinks = await resolveEvidenceLinks(row.evidenceUrls);
  const transaction = await sequelize.transaction();
  try {
    const artist = await Artist.create(
      {name: row.name, verificationState, extraInfo: row.extraInfo},
      {transaction},
    );
    if (row.aliases.length > 0) {
      await ArtistAlias.bulkCreate(
        row.aliases.map((alias) => ({artistId: artist.id, alias})),
        {transaction, ignoreDuplicates: true},
      );
    }
    if (row.links.length > 0) {
      await ArtistLink.bulkCreate(
        row.links.map((link) => ({artistId: artist.id, link})),
        {transaction, ignoreDuplicates: true},
      );
    }
    if (evidenceLinks.length > 0) {
      await ArtistEvidence.bulkCreate(
        evidenceLinks.map((link) => ({artistId: artist.id, link})),
        {transaction},
      );
    }
    await transaction.commit();
    return artist.id;
  } catch (error) {
    try {
      await transaction.rollback();
    } catch (rollbackError) {
      logger.warn('Artist verification create rollback failed', {error: errorMessage(rollbackError)});
    }
    throw error;
  }
}

async function updateArtistFromFeed(
  artistId: number,
  verificationState: SourceAlignedArtistState,
  extraInfo: string | null,
): Promise<boolean> {
  const [affected] = await Artist.update(
    {verificationState, extraInfo},
    {
      where: {
        id: artistId,
        verificationState: {[Op.ne]: 'ysmod_only'},
      },
    },
  );
  return affected > 0;
}

function matchesFor(
  index: ArtistSyncIndex,
  byId: Map<number, IndexedArtist>,
  names: string[],
): ArtistSyncMatch[] {
  const matches: ArtistSyncMatch[] = [];
  for (const id of matchArtistIds(index, names)) {
    const artist = byId.get(id);
    if (!artist) continue;
    matches.push({id, verificationState: artist.verificationState, extraInfo: artist.extraInfo});
  }
  return matches;
}

async function loadArtistIndex(): Promise<{
  index: ArtistSyncIndex;
  byId: Map<number, IndexedArtist>;
}> {
  const rows = await Artist.findAll({
    attributes: ['id', 'name', 'verificationState', 'extraInfo'],
    include: [{model: ArtistAlias, as: 'aliases', attributes: ['alias'], required: false}],
  });
  const index: ArtistSyncIndex = new Map();
  const byId = new Map<number, IndexedArtist>();
  for (const row of rows) {
    byId.set(row.id, {
      verificationState: localVerificationState(row.verificationState),
      extraInfo: row.extraInfo,
    });
    const aliasNames = (row.aliases ?? []).map((alias) => alias.alias);
    rememberArtistKeys(index, row.id, feedMatchNames(row.name, aliasNames));
  }
  return {index, byId};
}

async function runArtistVerificationSyncOnce(): Promise<ArtistVerificationSyncResult> {
  const feed = await fetchArtistFeed(artistVerificationFeedUrl());
  const counts = emptyCounts();
  counts.fetched = feed.length;
  const {index, byId} = await loadArtistIndex();

  for (const item of feed) {
    const row = parseArtistFeedRow(item);
    if (!row) {
      counts.errors += 1;
      continue;
    }
    const names = feedMatchNames(row.name, row.aliases);
    const decision = decideArtistVerificationSync({
      incoming: row.verificationState,
      extraInfo: row.extraInfo,
      matches: matchesFor(index, byId, names),
    });

    if (decision.kind === ARTIST_VERIFICATION_SYNC_ACTION.SKIP_UNALIGNED) {
      counts.skippedUnaligned += 1;
      continue;
    }
    if (decision.kind === ARTIST_VERIFICATION_SYNC_ACTION.SKIP_AMBIGUOUS) {
      counts.skippedAmbiguous += 1;
      continue;
    }
    if (decision.kind === ARTIST_VERIFICATION_SYNC_ACTION.SKIP_PROTECTED) {
      counts.skippedProtected += 1;
      continue;
    }
    if (decision.kind === ARTIST_VERIFICATION_SYNC_ACTION.NOOP) {
      counts.unchanged += 1;
      continue;
    }

    try {
      if (decision.kind === ARTIST_VERIFICATION_SYNC_ACTION.CREATE) {
        const artistId = await createArtistFromFeed(row, decision.verificationState);
        byId.set(artistId, {verificationState: decision.verificationState, extraInfo: row.extraInfo});
        rememberArtistKeys(index, artistId, names);
        counts.created += 1;
        continue;
      }
      const updated = await updateArtistFromFeed(
        decision.artistId,
        decision.verificationState,
        row.extraInfo,
      );
      if (!updated) {
        counts.skippedProtected += 1;
        const current = byId.get(decision.artistId);
        byId.set(decision.artistId, {
          verificationState: 'ysmod_only',
          extraInfo: current?.extraInfo ?? null,
        });
        continue;
      }
      byId.set(decision.artistId, {
        verificationState: decision.verificationState,
        extraInfo: row.extraInfo,
      });
      counts.updated += 1;
    } catch (error) {
      counts.errors += 1;
      logger.error('Artist verification sync failed for artist', {
        name: row.name,
        error: errorMessage(error),
      });
    }
  }

  return {...counts, alreadyRunning: false};
}

let syncInFlight: Promise<ArtistVerificationSyncResult> | null = null;

export async function runArtistVerificationSync(): Promise<ArtistVerificationSyncResult> {
  if (syncInFlight) {
    const result = await syncInFlight;
    return {...result, alreadyRunning: true};
  }
  const pending = runArtistVerificationSyncOnce().finally(() => {
    if (syncInFlight === pending) syncInFlight = null;
  });
  syncInFlight = pending;
  return pending;
}
