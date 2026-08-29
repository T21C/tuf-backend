import {isGithubHostedUrl} from './modFields.js';

export type MappedModSeed = {
  name: string;
  creatorUsername: string;
  creatorDiscordId: string;
  version: string | null;
  description: string | null;
  downloadUrl: string;
  imageUrl: string | null;
  sourceUploadedAt: Date;
  uploadedTimestamp: number;
};

function asTrimmedString(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function looksLikeHttpUrl(raw: string): boolean {
  return /^https?:\/\//i.test(raw);
}

function pickDownloadUrl(row: Record<string, unknown>): string | null {
  for (const key of ['parsedDownload', 'download'] as const) {
    const value = asTrimmedString(row[key]);
    if (value && looksLikeHttpUrl(value)) return value;
  }
  return null;
}

function parseUploadedTimestamp(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

export function mapModSeedRow(raw: unknown): MappedModSeed | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const name = asTrimmedString(row.name);
  const creatorUsername = asTrimmedString(row.cachedUsername);
  const creatorDiscordId = asTrimmedString(row.user);
  if (!name || !creatorUsername || !/^\d{5,32}$/.test(creatorDiscordId)) return null;
  const downloadUrl = pickDownloadUrl(row);
  if (!downloadUrl) return null;
  const uploadedTimestamp = parseUploadedTimestamp(row.uploadedTimestamp);
  if (uploadedTimestamp === null) return null;

  const versionRaw = asTrimmedString(row.version);
  const descriptionRaw = typeof row.description === 'string' ? row.description.trim() : '';
  const imageRaw = asTrimmedString(row.imageURL);
  const imageUrl =
    imageRaw && looksLikeHttpUrl(imageRaw) && isGithubHostedUrl(imageRaw) ? imageRaw : null;

  return {
    name,
    creatorUsername,
    creatorDiscordId,
    version: versionRaw || null,
    description: descriptionRaw || null,
    downloadUrl,
    imageUrl,
    sourceUploadedAt: new Date(uploadedTimestamp),
    uploadedTimestamp,
  };
}

export function mergeModSeedRows(rows: unknown[]): MappedModSeed[] {
  const byName = new Map<string, MappedModSeed>();
  for (const raw of rows) {
    const mapped = mapModSeedRow(raw);
    if (!mapped) continue;
    const key = mapped.name.toLowerCase();
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, mapped);
      continue;
    }
    if (mapped.uploadedTimestamp > existing.uploadedTimestamp) {
      byName.set(key, mapped);
      continue;
    }
    if (mapped.uploadedTimestamp === existing.uploadedTimestamp) {
      const mappedGithub = isGithubHostedUrl(mapped.downloadUrl);
      const existingGithub = isGithubHostedUrl(existing.downloadUrl);
      if (mappedGithub && !existingGithub) byName.set(key, mapped);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

export function toModCreateAttributes(row: MappedModSeed) {
  return {
    name: row.name,
    creatorUsername: row.creatorUsername,
    creatorDiscordId: row.creatorDiscordId,
    version: row.version,
    description: row.description,
    downloadUrl: row.downloadUrl,
    imageUrl: row.imageUrl,
    sourceUploadedAt: row.sourceUploadedAt,
    hidden: false,
  };
}
