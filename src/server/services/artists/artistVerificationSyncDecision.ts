import {
  type ArtistVerificationState,
  isArtistVerificationState,
} from '@/models/verificationStates.js';

/** Matches artists.name / artist_aliases.alias. */
export const ARTIST_SYNC_NAME_MAX = 255;

/**
 * Statuses https://7thbe.at/wapi/getArtists can express.
 * `ysmod_only` and `unverified` are local-only and must never be written from this feed.
 */
export const SOURCE_ALIGNED_ARTIST_STATES = [
  'pending',
  'declined',
  'mostly_declined',
  'mostly_allowed',
  'allowed',
] as const;

export type SourceAlignedArtistState = (typeof SOURCE_ALIGNED_ARTIST_STATES)[number];

const SOURCE_ALIGNED_ARTIST_STATE_SET: ReadonlySet<string> = new Set(SOURCE_ALIGNED_ARTIST_STATES);

export const ARTIST_VERIFICATION_SYNC_ACTION = {
  SKIP_UNALIGNED: 'skip_unaligned',
  SKIP_PROTECTED: 'skip_protected',
  SKIP_AMBIGUOUS: 'skip_ambiguous',
  CREATE: 'create',
  UPDATE: 'update',
  NOOP: 'noop',
} as const;

export type ArtistVerificationSyncAction =
  (typeof ARTIST_VERIFICATION_SYNC_ACTION)[keyof typeof ARTIST_VERIFICATION_SYNC_ACTION];

export type ArtistVerificationSyncDecision =
  | {kind: typeof ARTIST_VERIFICATION_SYNC_ACTION.SKIP_UNALIGNED}
  | {kind: typeof ARTIST_VERIFICATION_SYNC_ACTION.SKIP_PROTECTED; artistId: number}
  | {kind: typeof ARTIST_VERIFICATION_SYNC_ACTION.SKIP_AMBIGUOUS}
  | {kind: typeof ARTIST_VERIFICATION_SYNC_ACTION.CREATE; verificationState: SourceAlignedArtistState}
  | {
      kind: typeof ARTIST_VERIFICATION_SYNC_ACTION.UPDATE;
      artistId: number;
      verificationState: SourceAlignedArtistState;
    }
  | {kind: typeof ARTIST_VERIFICATION_SYNC_ACTION.NOOP; artistId: number};

export type ArtistSyncMatch = {
  id: number;
  verificationState: ArtistVerificationState;
  extraInfo?: string | null;
};

/** Normalized name -> local artist ids. Several ids means the key is ambiguous. */
export type ArtistSyncIndex = Map<string, Set<number>>;

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];

export function normalizeArtistSyncName(name: string): string {
  if (!name) return '';
  return name.trim().toLowerCase();
}

export function isSourceAlignedArtistState(value: unknown): value is SourceAlignedArtistState {
  return typeof value === 'string' && SOURCE_ALIGNED_ARTIST_STATE_SET.has(value);
}

function statusCode(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * Prefer `status_new` when it is present, including 0.
 * A missing or blank `status_new` falls back to `status`.
 */
export function pickSevenBgStatus(statusNew: unknown, status: unknown): number | null {
  const next = statusCode(statusNew);
  if (next !== null) return next;
  return statusCode(status);
}

/** Map a 7BG status code onto a source-aligned verification state. Unknown codes return null. */
export function mapSevenBgStatus(status: unknown): SourceAlignedArtistState | null {
  switch (statusCode(status)) {
    case 0:
      return 'pending';
    case 1:
      return 'allowed';
    case 2:
      return 'mostly_declined';
    case 3:
      return 'declined';
    case 4:
      return 'mostly_allowed';
    default:
      return null;
  }
}

export function feedMatchNames(name: string, aliases: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [name, ...aliases]) {
    const trimmed = raw.trim().slice(0, ARTIST_SYNC_NAME_MAX);
    const key = normalizeArtistSyncName(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export function rememberArtistKeys(index: ArtistSyncIndex, id: number, names: string[]): void {
  for (const name of names) {
    const key = normalizeArtistSyncName(name);
    if (!key) continue;
    let bucket = index.get(key);
    if (!bucket) {
      bucket = new Set();
      index.set(key, bucket);
    }
    bucket.add(id);
  }
}

export function matchArtistIds(index: ArtistSyncIndex, names: string[]): number[] {
  const ids = new Set<number>();
  for (const name of names) {
    const key = normalizeArtistSyncName(name);
    if (!key) continue;
    const bucket = index.get(key);
    if (!bucket) continue;
    for (const id of bucket) ids.add(id);
  }
  return [...ids];
}

/** artists.extraInfo is TEXT. Stay under the 64KB byte limit for multibyte disclaimers. */
const ARTIST_EXTRA_INFO_MAX_CHARS = 16_000;

export function normalizeArtistExtraInfo(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > ARTIST_EXTRA_INFO_MAX_CHARS
    ? trimmed.slice(0, ARTIST_EXTRA_INFO_MAX_CHARS)
    : trimmed;
}

/**
 * Same shape as the one-off 7BG import: `[LANG] text` blocks separated by a blank line.
 * Missing or empty disclaimer lists become null so a later sync can clear stale text.
 */
export function formatSevenBgDisclaimers(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  const lines: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const text = typeof record.text === 'string' ? record.text.trim() : '';
    if (!text) continue;
    const lang = typeof record.lang === 'string' ? record.lang.trim() : '';
    lines.push(lang ? `[${lang.toUpperCase()}] ${text}` : text);
  }
  return normalizeArtistExtraInfo(lines.join('\n\n'));
}

export function decideArtistVerificationSync(input: {
  incoming: ArtistVerificationState | null;
  extraInfo?: string | null;
  matches: ArtistSyncMatch[];
}): ArtistVerificationSyncDecision {
  if (!isSourceAlignedArtistState(input.incoming)) {
    return {kind: ARTIST_VERIFICATION_SYNC_ACTION.SKIP_UNALIGNED};
  }
  if (input.matches.length > 1) {
    return {kind: ARTIST_VERIFICATION_SYNC_ACTION.SKIP_AMBIGUOUS};
  }
  if (input.matches.length === 0) {
    return {kind: ARTIST_VERIFICATION_SYNC_ACTION.CREATE, verificationState: input.incoming};
  }
  const match = input.matches[0];
  if (match.verificationState === 'ysmod_only') {
    return {kind: ARTIST_VERIFICATION_SYNC_ACTION.SKIP_PROTECTED, artistId: match.id};
  }
  const incomingExtra = normalizeArtistExtraInfo(input.extraInfo);
  const localExtra = normalizeArtistExtraInfo(match.extraInfo);
  if (match.verificationState === input.incoming && localExtra === incomingExtra) {
    return {kind: ARTIST_VERIFICATION_SYNC_ACTION.NOOP, artistId: match.id};
  }
  return {
    kind: ARTIST_VERIFICATION_SYNC_ACTION.UPDATE,
    artistId: match.id,
    verificationState: input.incoming,
  };
}

function readStrings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

function uniqueStrings(values: Array<string | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 60_000 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export type ParsedArtistFeedRow = {
  name: string;
  aliases: string[];
  links: string[];
  evidenceUrls: string[];
  verificationState: SourceAlignedArtistState | null;
  extraInfo: string | null;
};

export function parseArtistFeedRow(raw: unknown): ParsedArtistFeedRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const name = typeof src.name === 'string' ? src.name.trim().slice(0, ARTIST_SYNC_NAME_MAX) : '';
  if (!normalizeArtistSyncName(name)) return null;
  const names = feedMatchNames(name, readStrings(src.aliases));
  if (names.length === 0) return null;
  const link1 = typeof src.link_1 === 'string' ? src.link_1 : null;
  const link2 = typeof src.link_2 === 'string' ? src.link_2 : null;
  return {
    name: names[0],
    aliases: names.slice(1),
    links: uniqueStrings([link1, link2]),
    evidenceUrls: uniqueStrings(readStrings(src.evidenceArray)),
    verificationState: mapSevenBgStatus(pickSevenBgStatus(src.status_new, src.status)),
    extraInfo: formatSevenBgDisclaimers(src.adofai_artist_disclaimers),
  };
}

/** Same image heuristic as the one-off 7BG import. Non-images are stored as external links. */
export function isEvidenceImageUrl(url: string): boolean {
  const lower = url.toLowerCase();
  if (IMAGE_EXTENSIONS.some((ext) => lower.includes(ext))) return true;
  if (lower.includes('/images/') || lower.includes('/image/') || lower.includes('evidence')) return true;
  return false;
}

export function localVerificationState(value: unknown): ArtistVerificationState {
  return isArtistVerificationState(value) ? value : 'unverified';
}
