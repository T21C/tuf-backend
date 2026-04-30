import path from 'path';

export type AudioCandidate = {
  /** Archive-relative path using forward slashes, e.g. "Songs/foo.ogg" */
  relativePath: string;
};

function posixNorm(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

function baseName(p: string): string {
  return path.posix.basename(posixNorm(p));
}

function dirName(p: string): string {
  const d = path.posix.dirname(posixNorm(p));
  return d === '.' ? '' : d;
}

/**
 * Resolve which audio file to use for duration, even when filenames are mojibake/unreliable.
 *
 * Rules:
 * 1) If `settingsSongFilename` exists: exact relativePath match; else basename match in same dir as level; else basename match anywhere.
 * 2) If still not found: first audio in same dir as level; else first audio anywhere.
 */
export function resolveAudioRelativePath(params: {
  candidates: AudioCandidate[];
  levelRelativePath: string | null | undefined;
  settingsSongFilename: unknown;
}): string | null {
  const candidates = (params.candidates || [])
    .map(c => ({ relativePath: posixNorm(c.relativePath) }))
    .filter(c => c.relativePath.length > 0);

  if (candidates.length === 0) return null;

  const levelDir = params.levelRelativePath ? dirName(params.levelRelativePath) : '';

  const songFilename =
    typeof params.settingsSongFilename === 'string' ? params.settingsSongFilename.trim() : '';

  if (songFilename) {
    const normSong = posixNorm(songFilename);
    const exact = candidates.find(c => c.relativePath === normSong);
    if (exact) return exact.relativePath;

    const wantBase = baseName(normSong);
    const sameDir = levelDir
      ? candidates.find(c => dirName(c.relativePath) === levelDir && baseName(c.relativePath) === wantBase)
      : undefined;
    if (sameDir) return sameDir.relativePath;

    const anyBase = candidates.find(c => baseName(c.relativePath) === wantBase);
    if (anyBase) return anyBase.relativePath;
  }

  if (levelDir) {
    const firstSameDir = candidates.find(c => dirName(c.relativePath) === levelDir);
    if (firstSameDir) return firstSameDir.relativePath;
  }

  return candidates[0].relativePath;
}

