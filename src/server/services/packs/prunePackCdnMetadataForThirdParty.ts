/**
 * Slim CDN LEVELZIP metadata for `GET /packs/:id/cdnData` third-party consumers.
 *
 * Preserved contract:
 * - `targetLevelRelativePath` — string when present
 * - `levelFiles` — **array** of `{ name, relativePath?, songFilename?, size? }` (`size` in bytes when present)
 * - `songFiles` — **array** of `{ name, size? }` (`size` in bytes when present)
 *
 * Omitted: full paths, BPM, `levelFiles` object map, `allLevelFiles` duplicate, `originalZip`,
 * per-file CDN keys, parse flags, etc.
 */
function finiteFileSize(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.length > 0) {
    const n = Number(value);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return undefined;
}

export function prunePackCdnMetadataForThirdParty(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }

  const out: Record<string, unknown> = {};

  const tp = metadata.targetLevelRelativePath;
  if (typeof tp === 'string' && tp.length > 0) {
    out.targetLevelRelativePath = tp;
  }

  const levelRows: Array<{
    name: string;
    relativePath?: string;
    songFilename?: string;
    size?: number;
  }> = [];

  const all = metadata.allLevelFiles;
  if (Array.isArray(all)) {
    for (const row of all) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const r = row as Record<string, unknown>;
      const name = typeof r.name === 'string' ? r.name : '';
      if (!name) continue;
      const entry: {
        name: string;
        relativePath?: string;
        songFilename?: string;
        size?: number;
      } = { name };
      if (typeof r.relativePath === 'string' && r.relativePath.length > 0) {
        entry.relativePath = r.relativePath;
      }
      if (typeof r.songFilename === 'string' && r.songFilename.length > 0) {
        entry.songFilename = r.songFilename;
      }
      const sz = finiteFileSize(r.size);
      if (sz !== undefined) {
        entry.size = sz;
      }
      levelRows.push(entry);
    }
  }

  if (levelRows.length === 0) {
    const lf = metadata.levelFiles;
    if (lf && typeof lf === 'object' && !Array.isArray(lf)) {
      for (const v of Object.values(lf)) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
        const r = v as Record<string, unknown>;
        const name = typeof r.name === 'string' ? r.name : '';
        if (!name) continue;
        const entry: {
          name: string;
          relativePath?: string;
          songFilename?: string;
          size?: number;
        } = { name };
        if (typeof r.relativePath === 'string' && r.relativePath.length > 0) {
          entry.relativePath = r.relativePath;
        }
        if (typeof r.songFilename === 'string' && r.songFilename.length > 0) {
          entry.songFilename = r.songFilename;
        }
        const sz = finiteFileSize(r.size);
        if (sz !== undefined) {
          entry.size = sz;
        }
        levelRows.push(entry);
      }
    }
  }

  out.levelFiles = levelRows;

  const songRows: Array<{ name: string; size?: number }> = [];
  const sf = metadata.songFiles;
  if (sf && typeof sf === 'object' && !Array.isArray(sf)) {
    for (const v of Object.values(sf)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const r = v as Record<string, unknown>;
      const name = typeof r.name === 'string' ? r.name : '';
      if (name) {
        const song: { name: string; size?: number } = { name };
        const sz = finiteFileSize(r.size);
        if (sz !== undefined) {
          song.size = sz;
        }
        songRows.push(song);
      }
    }
  }
  out.songFiles = songRows;

  if (
    levelRows.length === 0 &&
    songRows.length === 0 &&
    typeof out.targetLevelRelativePath !== 'string'
  ) {
    return null;
  }

  return out;
}
