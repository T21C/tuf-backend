/**
 * Canonical lowercase dotted extensions for audio treated as level-pack payload
 * (ingest, oversized backfill, 7-Zip filtered extract, path trimming, transform fallbacks).
 *
 * Keep MIME map keys in lockstep with {@link LEVEL_SUPPORTED_AUDIO_EXTENSIONS}.
 */
export const LEVEL_SUPPORTED_AUDIO_EXTENSIONS = [
    '.mp3',
    '.wav',
    '.ogg',
    '.oga',
    '.opus',
    '.flac',
    '.m4a',
    '.aac',
    '.aiff',
    '.aif',
    '.caf',
    '.wma',
    '.webm',
    '.mka',
    '.ac3',
    '.eac3',
    '.mp2',
    '.amr',
    '.ape',
    '.wv',
    '.tta'
] as const;

export type LevelSupportedAudioExtension = (typeof LEVEL_SUPPORTED_AUDIO_EXTENSIONS)[number];

export const LEVEL_SUPPORTED_AUDIO_EXTENSION_SET: ReadonlySet<string> = new Set(LEVEL_SUPPORTED_AUDIO_EXTENSIONS);

/** MIME types for R2 / Spaces `Content-Type` on uploaded song objects. */
export const LEVEL_SUPPORTED_AUDIO_CONTENT_TYPE_BY_EXT: Record<LevelSupportedAudioExtension, string> = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.opus': 'audio/opus',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.aiff': 'audio/aiff',
    '.aif': 'audio/aiff',
    '.caf': 'audio/x-caf',
    '.wma': 'audio/x-ms-wma',
    '.webm': 'audio/webm',
    '.mka': 'audio/x-matroska',
    '.ac3': 'audio/ac3',
    '.eac3': 'audio/eac3',
    '.mp2': 'audio/mpeg',
    '.amr': 'audio/amr',
    '.ape': 'audio/x-ape',
    '.wv': 'audio/wavpack',
    '.tta': 'audio/tta'
};

/**
 * Builds 7-Zip `-i!` include switches for each extension (lowercase + UPPERCASE globs).
 * `dottedExtensions` entries should be like `.mp3` (leading dot optional).
 */
export function levelPackDottedExtToSevenZipIncludeGlobs(dottedExtensions: readonly string[]): string[] {
    const out: string[] = [];
    for (const dotted of dottedExtensions) {
        const token = dotted.startsWith('.') ? dotted.slice(1) : dotted;
        if (!token || /[/\\*?]/.test(token)) {
            throw new Error(`Invalid extension for 7z include glob: ${dotted}`);
        }
        out.push(`-i!*.${token}`, `-i!*.${token.toUpperCase()}`);
    }
    return out;
}

/** `-i!` patterns for `.adofai` + {@link LEVEL_SUPPORTED_AUDIO_EXTENSIONS} (used by `7z x -r`). */
export const LEVEL_PACK_PAYLOAD_SEVEN_ZIP_INCLUDE_GLOBS: readonly string[] = Object.freeze([
    ...levelPackDottedExtToSevenZipIncludeGlobs(['.adofai']),
    ...levelPackDottedExtToSevenZipIncludeGlobs([...LEVEL_SUPPORTED_AUDIO_EXTENSIONS])
]);
