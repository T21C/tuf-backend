/**
 * A downloaded chart can play music from a bundled audio file, or from
 * YouTubeStream (YSMod) when that mod is required and a link is attached.
 */

type LevelFileHint = {
    name?: unknown;
    relativePath?: unknown;
    path?: unknown;
    hasYouTubeStream?: unknown;
    songFilename?: unknown;
    songURL?: unknown;
};

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function levelFiles(metadata: Record<string, unknown>): LevelFileHint[] {
    const raw = metadata.allLevelFiles;
    if (Array.isArray(raw)) return raw as LevelFileHint[];
    if (raw && typeof raw === 'object') return Object.values(raw as Record<string, LevelFileHint>);
    return [];
}

function targetLevelFile(metadata: Record<string, unknown>): LevelFileHint | null {
    const files = levelFiles(metadata);
    const rel = text(metadata.targetLevelRelativePath);
    const target = text(metadata.targetLevel);
    if (rel) {
        const hit = files.find((file) => text(file.relativePath) === rel || text(file.name) === rel);
        if (hit) return hit;
    }
    if (target) {
        const base = target.split(/[/\\]/).pop() ?? target;
        const hit = files.find((file) =>
            text(file.path) === target
            || text(file.relativePath) === target
            || text(file.name) === target
            || text(file.name) === base
        );
        if (hit) return hit;
    }
    return files.length === 1 ? files[0] : null;
}

function hasBundledSong(metadata: Record<string, unknown>): boolean {
    const songFiles = metadata.songFiles;
    return !!songFiles
        && typeof songFiles === 'object'
        && !Array.isArray(songFiles)
        && Object.keys(songFiles).length > 0;
}

export function chartRequiresYouTubeStream(requiredMods: unknown): boolean {
    return Array.isArray(requiredMods)
        && requiredMods.some((mod) => typeof mod === 'string' && mod.includes('YouTubeStream'));
}

export function chartSongUrl(songURL: unknown): string | undefined {
    const trimmed = text(songURL);
    return trimmed.length > 0 ? trimmed : undefined;
}

function isStreamLink(value: string): boolean {
    if (!value) return false;
    if (/^https?:\/\//i.test(value)) return true;
    return /youtu\.be\/|youtube\.com\//i.test(value);
}

function readCacheSettings(cacheData: string | null | undefined): Record<string, unknown> | null {
    if (!cacheData) return null;
    try {
        const parsed = JSON.parse(cacheData) as { settings?: unknown };
        const settings = parsed?.settings;
        if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
            return settings as Record<string, unknown>;
        }
    } catch {
        return null;
    }
    return null;
}

/** True when the archive has neither a song file nor YSMod with a link. */
export function levelArchiveMissingSong(
    metadata: Record<string, unknown>,
    cacheData?: string | null
): boolean {
    if (hasBundledSong(metadata)) return false;

    const settings = readCacheSettings(cacheData);
    const entry = targetLevelFile(metadata);
    const hasYsmod = entry?.hasYouTubeStream === true
        || metadata.hasYouTubeStream === true
        || chartRequiresYouTubeStream(settings?.requiredMods);
    if (!hasYsmod) return true;

    const songURL = chartSongUrl(settings?.songURL)
        || chartSongUrl(entry?.songURL)
        || chartSongUrl(metadata.songURL);
    if (songURL) return false;

    const songFilename = text(settings?.songFilename) || text(entry?.songFilename);
    return !isStreamLink(songFilename);
}
