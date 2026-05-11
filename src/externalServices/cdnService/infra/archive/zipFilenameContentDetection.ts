import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import iconv from 'iconv-lite';
import { logger } from '@/server/services/core/LoggerService.js';
import { LEVEL_SUPPORTED_AUDIO_EXTENSIONS } from '@/externalServices/cdnService/constants/levelPackAudio.js';
import { extractAdofaiFilesForDetection } from './archiveService.js';
import { scanOversizedLevelFile } from '@/externalServices/cdnService/domain/level/oversizedHandling/oversizedLevelScan.js';
import type { ZipCentralDirectoryEntry } from './zipCentralDirectory.js';

/**
 * Content-aware ZIP filename code-page detection.
 *
 * Byte-pattern heuristics genuinely cannot tell CP932 / CP936 / CP949 / CP950 apart for
 * common CJK filenames — the lead+trail byte ranges of those code pages overlap almost
 * completely. The fix is to look at the *content* of the archive: every `.adofai` is a
 * UTF-8 JSON document whose `settings.songFilename` field stores the (correct, in-game-
 * typed) audio filename the player intended. If we decode each audio entry's *raw bytes*
 * through every candidate codec and one of them produces a string that NFC-equals (or
 * NFC-contains) the songFilename from the JSON, that's a near-deterministic identification.
 *
 * Flow:
 *   1. Walk the supplied CD entries; pick `.adofai` and audio entries by ASCII suffix
 *      match on the *raw* filename bytes (the `.adofai`/`.wav`/... suffix is pure ASCII
 *      and survives any legacy decoding). The CD walk is purely a gate — if there are no
 *      `.adofai` or no audio entries, skip the (much heavier) extraction step.
 *   2. Drive {@link extractAdofaiFilesForDetection} — a 7-Zip filtered `-i!*.adofai`
 *      extract — to dump just the `.adofai` files into a temp directory. This is the
 *      same CDN-standard 7-Zip codepath as every other archive operation; there is no
 *      `adm-zip`, no second ZIP reader, and no need to load multi-gigabyte archives
 *      into memory. Mojibake parent-folder names on disk are fine: the *contents* of
 *      `.adofai` are always UTF-8 regardless of how the archive named the entry.
 *   3. Stream-scan each extracted `.adofai` with {@link scanOversizedLevelFile} (bounded
 *      memory, tolerant of malformed JSON via its regex fallback). Pull
 *      `songFilename` / `song` / `artist` / `author` from `settings`.
 *   4. For each candidate codec (Korean → Simplified Chinese → Big5 → Japanese → Latin),
 *      decode every audio entry's basename and score it against the reference strings.
 *      Comparisons use {@link normalizeLegacyFilenameComparison} so a ZIP basename that uses
 *      ASCII `-` between words while `.adofai` uses `●` / `・` / an em dash still produces a
 *      stem match for the correct legacy decode (otherwise every codec scores 0 and the
 *      byte fallback picks an arbitrary CJK code page).
 *   5. Highest aggregate score wins. Any codec that reproduces `settings.songFilename` (or the
 *      `settings.song` stem) exactly after normalization receives {@link SCORE_PERFECT_SONG_LOCK}
 *      once — far above accumulated substring noise so the right CP949 / CP932 / … wins even
 *      when other fields spuriously match wrong decodings. If no codec clears the floor, fall
 *      back to the byte-pattern heuristic.
 */

interface AdofaiReferenceStrings {
    songFilename?: string;
    song?: string;
    artist?: string;
    author?: string;
}

/** Candidate codecs in **player-base order**: Korean first, then Simplified, Traditional, Japanese, Latin. */
export const CONTENT_AWARE_CANDIDATES: readonly { codec: string; codePage: 932 | 936 | 949 | 950 | 1252; label: string }[] = Object.freeze([
    { codec: 'cp949', codePage: 949 as const, label: 'cp949-kr' },
    { codec: 'cp936', codePage: 936 as const, label: 'cp936-cn' },
    { codec: 'big5', codePage: 950 as const, label: 'cp950-tw' },
    { codec: 'shift_jis', codePage: 932 as const, label: 'cp932-jp' },
    { codec: 'cp1252', codePage: 1252 as const, label: 'cp1252-eu' }
]);

/** Score buckets — keep gaps wide so summing across many entries doesn't blur tiers. */
const SCORE_EXACT = 1000;
const SCORE_EXACT_CI = 800;
const SCORE_STEM = 500;
const SCORE_STEM_CI = 400;
const SCORE_SUBSTRING = 200;
const SCORE_SUBSTRING_CI = 150;
const SCORE_KNOCKOUT = -1000;

/**
 * One-shot bonus per codec when any audio basename matches the chart's song reference
 * exactly (after {@link normalizeLegacyFilenameComparison}). Must dwarf sums of substring
 * hits from `artist`/`author` on wrong decodings so CP949 vs CP932 disambiguates correctly.
 */
const SCORE_PERFECT_SONG_LOCK = 10_000_000;

/** Minimum aggregate score for content-aware detection to be considered conclusive. */
const SCORE_FLOOR_FOR_DECISION = 200;

/**
 * NFKC + unify bullets / dashes / middle dots so ZIP paths typed differently from
 * `settings.songFilename` still match (e.g. `foo - bar.ogg` vs `foo ● bar.ogg`).
 */
function normalizeLegacyFilenameComparison(s: string): string {
    let t = s.normalize('NFKC');
    // Bullets / middle dots / katakana middle dot → hyphen for comparison only
    t = t.replace(/[\u25CF\u2022\u2023\u2219\u22C5\u30FB\uFF65\u00B7\u2024\u2981]/g, '-');
    // Unicode dashes / minus → ASCII hyphen
    t = t.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFF0D]/g, '-');
    t = t.replace(/\s+/g, ' ').trim();
    return t;
}

export interface ContentAwareDetection {
    codePage: 932 | 936 | 949 | 950 | 1252;
    /** Aggregate score for the winning codec (sum across all audio × reference pairs). */
    score: number;
    /** Human-readable rationale ("cp949-kr: exact=1, substring=2, knockout=0"). */
    reason: string;
    /** Per-codec totals, useful for log inspection of close calls. */
    perCodec: { codePage: number; score: number; label: string; perfectSongLock?: number }[];
}

/**
 * Inspect a ZIP's `.adofai` payload to pick the legacy code page whose decoding of the
 * audio entries' filenames best matches `settings.songFilename` from the JSON.
 *
 * Returns `null` when:
 *  - the archive has no `.adofai` or no audio entries (cheap CD-walk gate);
 *  - 7-Zip refused to extract any `.adofai` (corrupt archive, encrypted, IO error, …);
 *  - the `.adofai` JSON yields no useful reference strings;
 *  - no candidate codec scored above {@link SCORE_FLOOR_FOR_DECISION}.
 */
export async function detectZipFilenameCodePageByContent(
    filePath: string,
    entries: readonly ZipCentralDirectoryEntry[]
): Promise<ContentAwareDetection | null> {
    const adofaiEntries = entries.filter((e) => bufferEndsWithAsciiSuffix(e.rawNameBytes, '.adofai'));
    if (adofaiEntries.length === 0) return null;

    const audioEntries = entries.filter((e) =>
        LEVEL_SUPPORTED_AUDIO_EXTENSIONS.some((ext) => bufferEndsWithAsciiSuffix(e.rawNameBytes, ext))
    );
    if (audioEntries.length === 0) return null;

    const refs = await readAdofaiReferencesViaSevenZip(filePath);
    if (!refs) return null;

    /** Reference strings sorted strong→weak (songFilename should match the audio basename exactly). */
    const refList: { value: string; kind: 'songFilename' | 'song' | 'artist' | 'author' }[] = [];
    if (refs.songFilename) refList.push({ value: refs.songFilename, kind: 'songFilename' });
    if (refs.song) refList.push({ value: refs.song, kind: 'song' });
    if (refs.artist) refList.push({ value: refs.artist, kind: 'artist' });
    if (refs.author) refList.push({ value: refs.author, kind: 'author' });
    if (refList.length === 0) return null;

    /** Pre-extract just the basenames of audio entries (raw bytes); we'll decode these per codec. */
    const audioBasenames = audioEntries.map((e) => basenameOfRawBytes(e.rawNameBytes));

    const perCodec: {
        codePage: 932 | 936 | 949 | 950 | 1252;
        score: number;
        label: string;
        counters: ScoreCounters;
        perfectSongLock: number;
    }[] = [];
    for (const cand of CONTENT_AWARE_CANDIDATES) {
        const counters: ScoreCounters = { exact: 0, exactCi: 0, stem: 0, stemCi: 0, substring: 0, substringCi: 0, knockout: 0 };
        let totalScore = 0;
        let perfectSongLock = 0;
        for (const rawBasename of audioBasenames) {
            let decoded: string;
            try {
                decoded = iconv.decode(rawBasename, cand.codec).normalize('NFC');
            } catch {
                continue;
            }
            // Track the best score across reference strings; only count it once per audio entry.
            let bestForEntry = 0;
            let bestKind: keyof ScoreCounters | 'none' = 'none';
            for (const ref of refList) {
                const refNorm = ref.value.normalize('NFC');
                const { score: s, kind } = scoreDecodedAgainstReference(decoded, refNorm, ref.kind);
                if (s > bestForEntry) {
                    bestForEntry = s;
                    bestKind = kind;
                }
            }
            if (bestKind !== 'none') counters[bestKind]++;
            totalScore += bestForEntry;
            if (perfectSongLock === 0 && matchesSongGroundTruth(decoded, refs)) {
                perfectSongLock = SCORE_PERFECT_SONG_LOCK;
            }
        }
        totalScore += perfectSongLock;
        perCodec.push({ codePage: cand.codePage, score: totalScore, label: cand.label, counters, perfectSongLock });
    }

    perCodec.sort((a, b) => b.score - a.score);
    const winner = perCodec[0];
    if (!winner || winner.score < SCORE_FLOOR_FOR_DECISION) return null;

    const lockNote = winner.perfectSongLock > 0 ? `+perfectSongLock=${winner.perfectSongLock}` : '';
    return {
        codePage: winner.codePage,
        score: winner.score,
        reason: `${winner.label}:${formatCounters(winner.counters)}${lockNote}`,
        perCodec: perCodec.map((p) => ({
            codePage: p.codePage,
            score: p.score,
            label: p.label,
            ...(p.perfectSongLock > 0 ? { perfectSongLock: p.perfectSongLock } : {}),
        })),
    };
}

interface ScoreCounters {
    exact: number;
    exactCi: number;
    stem: number;
    stemCi: number;
    substring: number;
    substringCi: number;
    knockout: number;
}

function formatCounters(c: ScoreCounters): string {
    const parts: string[] = [];
    if (c.exact) parts.push(`exact=${c.exact}`);
    if (c.exactCi) parts.push(`exactCi=${c.exactCi}`);
    if (c.stem) parts.push(`stem=${c.stem}`);
    if (c.stemCi) parts.push(`stemCi=${c.stemCi}`);
    if (c.substring) parts.push(`substring=${c.substring}`);
    if (c.substringCi) parts.push(`substringCi=${c.substringCi}`);
    if (c.knockout) parts.push(`knockout=${c.knockout}`);
    return parts.length > 0 ? parts.join(',') : 'no-matches';
}

/**
 * Score a single (decoded audio basename, reference string) pair. The hierarchy:
 *  - Exact NFC equality → strongest signal; the codec round-tripped perfectly.
 *  - Case-insensitive equality → strong (Windows-style filename comparison).
 *  - Stem (basename without extension) equality → strong; user changed the file extension.
 *  - Substring containment → weak; user renamed but kept a recognisable substring.
 *  - Containing `\uFFFD` → knockout; this codec can't decode these bytes at all.
 *
 * Returns a kind tag for log inspection so we can see *why* a codec won.
 */
function scoreDecodedAgainstReference(
    decoded: string,
    reference: string,
    refKind: 'songFilename' | 'song' | 'artist' | 'author'
): { score: number; kind: keyof ScoreCounters | 'none' } {
    if (!reference) return { score: 0, kind: 'none' };

    if (decoded.includes('\uFFFD')) {
        return { score: SCORE_KNOCKOUT, kind: 'knockout' };
    }

    const allowExact = refKind === 'songFilename';
    const decCmp = normalizeLegacyFilenameComparison(decoded);
    const refCmp = normalizeLegacyFilenameComparison(reference);

    if (allowExact && decCmp === refCmp) return { score: SCORE_EXACT, kind: 'exact' };
    if (allowExact && decCmp.toLowerCase() === refCmp.toLowerCase()) {
        return { score: SCORE_EXACT_CI, kind: 'exactCi' };
    }

    const decodedStem = normalizeLegacyFilenameComparison(stripExt(decoded));
    const referenceStem = normalizeLegacyFilenameComparison(stripExt(reference));
    if (allowExact && decodedStem === referenceStem) return { score: SCORE_STEM, kind: 'stem' };
    if (allowExact && decodedStem.toLowerCase() === referenceStem.toLowerCase()) {
        return { score: SCORE_STEM_CI, kind: 'stemCi' };
    }

    const needle = (allowExact ? referenceStem : normalizeLegacyFilenameComparison(reference)).trim();
    if (needle.length >= 2) {
        if (decCmp.includes(needle)) return { score: SCORE_SUBSTRING, kind: 'substring' };
        if (decCmp.toLowerCase().includes(needle.toLowerCase())) {
            return { score: SCORE_SUBSTRING_CI, kind: 'substringCi' };
        }
    }

    return { score: 0, kind: 'none' };
}

function stripExt(name: string): string {
    const idx = name.lastIndexOf('.');
    if (idx <= 0) return name;
    return name.slice(0, idx);
}

/**
 * True when decoded audio basename matches chart ground truth: full `songFilename`, or
 * basename stem vs `settings.song` (same normalization as scoring).
 */
function matchesSongGroundTruth(decoded: string, refs: AdofaiReferenceStrings): boolean {
    if (decoded.includes('\uFFFD')) return false;
    if (refs.songFilename) {
        const r = scoreDecodedAgainstReference(decoded, refs.songFilename.normalize('NFC'), 'songFilename');
        if (r.kind === 'exact' || r.kind === 'exactCi') return true;
    }
    if (refs.song) {
        const decStem = normalizeLegacyFilenameComparison(stripExt(decoded));
        const songStem = normalizeLegacyFilenameComparison(refs.song.trim());
        if (decStem === songStem || decStem.toLowerCase() === songStem.toLowerCase()) return true;
    }
    return false;
}

/**
 * Case-insensitive ASCII-suffix check on raw bytes. Used to identify entries by extension
 * (`.adofai`, `.wav`, `.mp3`, …) without committing to any non-ASCII decoding of the prefix.
 */
function bufferEndsWithAsciiSuffix(buf: Buffer, suffix: string): boolean {
    if (buf.length < suffix.length) return false;
    const start = buf.length - suffix.length;
    for (let i = 0; i < suffix.length; i++) {
        const b = buf[start + i];
        const want = suffix.charCodeAt(i);
        const wantLower = want >= 0x41 && want <= 0x5a ? want + 0x20 : want;
        const bLower = b >= 0x41 && b <= 0x5a ? b + 0x20 : b;
        if (bLower !== wantLower) return false;
    }
    return true;
}

/** Return the trailing slice of `buf` after the last `/` or `\`. Pure byte op; no decoding. */
function basenameOfRawBytes(buf: Buffer): Buffer {
    for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i] === 0x2f || buf[i] === 0x5c) return buf.subarray(i + 1);
    }
    return buf;
}

/**
 * Extract reference strings (`songFilename` / `song` / `artist` / `author`) from any
 * `.adofai` inside the archive, using the **shared CDN 7-Zip path** + the existing
 * **streaming oversized-level scanner**. No `adm-zip`, no second ZIP reader, and never
 * loads more than {@link scanOversizedLevelFile}'s rolling window into memory regardless
 * of archive or `.adofai` file size.
 *
 * Failure semantics: returns `null` rather than throwing — the caller has a byte-pattern
 * fallback and we don't want best-effort detection to crash the upload pipeline.
 */
async function readAdofaiReferencesViaSevenZip(filePath: string): Promise<AdofaiReferenceStrings | null> {
    const tempDir = path.join(os.tmpdir(), `zip-fn-detect-${crypto.randomUUID()}`);

    try {
        const extractedAdofaiPaths = await extractAdofaiFilesForDetection(filePath, tempDir);
        if (extractedAdofaiPaths.length === 0) {
            logger.debug('zipFilenameContentDetection: 7z extracted no .adofai files; cannot do content-aware detection', {
                filePath
            });
            return null;
        }

        // Try the smallest .adofai first — settings are usually near the top of the file and a
        // smaller chart means the streaming scanner finishes faster. We then fall through to the
        // next-smallest if the first yields nothing usable (e.g. a stray empty `.adofai`).
        const withSizes: { path: string; size: number }[] = [];
        for (const p of extractedAdofaiPaths) {
            try {
                const st = await fs.promises.stat(p);
                if (st.isFile() && st.size > 0) withSizes.push({ path: p, size: st.size });
            } catch {
                /* unreadable; skip */
            }
        }
        withSizes.sort((a, b) => a.size - b.size);

        for (const { path: adofaiPath } of withSizes) {
            let scanned;
            try {
                scanned = await scanOversizedLevelFile(adofaiPath);
            } catch (err) {
                logger.debug('zipFilenameContentDetection: scanOversizedLevelFile threw; trying next .adofai', {
                    adofaiPath,
                    error: err instanceof Error ? err.message : String(err)
                });
                continue;
            }

            const refs: AdofaiReferenceStrings = {
                songFilename: pickString(scanned.settings.songFilename),
                song: pickString(scanned.settings.song),
                artist: pickString(scanned.settings.artist),
                author: pickString(scanned.settings.author)
            };
            if (refs.songFilename || refs.song || refs.artist || refs.author) {
                return refs;
            }
        }

        return null;
    } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
}

/** Coerce an `unknown` settings value to a usable trimmed string, or `undefined`. */
function pickString(v: unknown): string | undefined {
    if (typeof v !== 'string') return undefined;
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
