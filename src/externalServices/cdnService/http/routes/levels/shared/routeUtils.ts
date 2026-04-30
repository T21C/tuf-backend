import path from 'path';

export function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[<>:"\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .substring(0, 255);
}

export function encodeContentDisposition(filename: string): string {
  const sanitized = sanitizeFilename(filename);
  const encoded = encodeURIComponent(sanitized);
  return `attachment; filename*=UTF-8''${encoded}`;
}

export function posixNorm(p: string): string {
    return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * Resolve a chart's `songFilename` to stored CDN song metadata. Keys may be basename-only (legacy)
 * or archive-relative paths (disambiguates duplicate basenames in nested folders).
 */
export function resolveSongFileForTransform(
    songFiles: Record<string, { name: string; path: string; size: number; type: string }>,
    songFilename: string | undefined,
    targetLevelRelativePath: string | undefined
): { name: string; path: string; size: number; type: string } | undefined {
    if (!songFiles || songFilename === undefined || songFilename === '') {
        return undefined;
    }
    const normSong = posixNorm(songFilename);
    const hitExact = songFiles[normSong] ?? songFiles[songFilename];
    if (hitExact) {
        return hitExact;
    }

    const tgt = targetLevelRelativePath ? posixNorm(targetLevelRelativePath) : '';
    const levelDir = tgt ? path.posix.dirname(tgt) : '';

    if (normSong.includes('/') && !normSong.startsWith('..')) {
        const hit = songFiles[normSong];
        if (hit) {
            return hit;
        }
    } else if (levelDir && levelDir !== '.' && levelDir !== '') {
        const nextToLevel = `${levelDir}/${path.posix.basename(normSong)}`;
        const hit2 = songFiles[nextToLevel];
        if (hit2) {
            return hit2;
        }
    }

    const wantBase = path.posix.basename(normSong);
    let fallback: { name: string; path: string; size: number; type: string } | undefined;
    for (const [key, song] of Object.entries(songFiles)) {
        const keyNorm = posixNorm(key);
        if (path.posix.basename(keyNorm) !== wantBase) {
            continue;
        }
        if (levelDir && path.posix.dirname(keyNorm) === levelDir) {
            return song;
        }
        if (!fallback) {
            fallback = song;
        }
    }
    return fallback;
}

export function extractLevelMetadata(metadata: any) {
    return {
        songFiles: Object.values(metadata.songFiles).map((songFile: any) => {
            return {
                name: songFile.name,
                size: songFile.size,
                type: songFile.type
            };
        }),
        allLevelFiles: Object.values(metadata.allLevelFiles).map((levelFile: any) => {
            return {
                name: levelFile.name,
                size: levelFile.size,
                songFilename: levelFile.songFilename,
                hasYouTubeStream: levelFile.hasYouTubeStream,
                oversizedUnparsed: !!levelFile.oversizedUnparsed
            };
        }),
        originalZip: {
            name: metadata.originalZip.name,
            size: metadata.originalZip.size,
            originalFilename: metadata.originalZip.originalFilename
        },
        transformUnavailable: !!metadata.targetLevelOversized
    };
}

