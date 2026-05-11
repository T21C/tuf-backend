import { logger } from '@/server/services/core/LoggerService.js';
import { readZipCentralDirectoryNames } from './zipCentralDirectory.js';
import { detectZipFilenameCodePageByContent } from './zipFilenameContentDetection.js';

/**
 * Detect which legacy code page a `.zip` archive used for its filename bytes, so
 * 7-Zip can be told (via `-mcp=N`) to decode them the same way the writer encoded
 * them. This eliminates the `ܡ�������.adofai` mojibake produced when force-UTF-8
 * (`-mcu=on`) is applied to ZIPs whose entries pre-date the UTF-8 flag (GPF bit 11).
 *
 * Decision tree per archive:
 *   1. Parse central directory headers. If parsing is skipped (ZIP64, IO error, no
 *      EOCD, etc.), return `codePage: null` and let 7-Zip use its default behaviour.
 *   2. If every entry that has non-ASCII filename bytes also has GPF bit 11 set, or
 *      an Info-ZIP Unicode Path Extra Field (0x7075), return `null` — UTF-8 is fine.
 *   3. If the concatenated legacy bytes happen to decode as valid UTF-8 (common for
 *      Linux `zip` that forgot to set bit 11), return `null` — UTF-8 still works.
 *   4. **Content-aware step**: decode every audio entry's basename through each
 *      candidate codec and compare against `settings.songFilename` from one of the
 *      archive's `.adofai` JSON payloads (which is always reliably UTF-8). Whatever
 *      codec produces an exact / case-insensitive / stem / substring match wins. This
 *      step deterministically disambiguates the CP932 / CP936 / CP949 / CP950 cases
 *      where byte ranges alias.
 *   5. Otherwise score the bytes against CP949 / CP936 / CP950 / CP932 / CP1252 and
 *      return the highest scorer. The candidate order matches the player-base
 *      distribution (Korean ≫ Simplified Chinese > Big5 > Japanese > Latin) so ties
 *      resolve to the most-likely encoding rather than alphabetic order.
 *
 * Scope: ZIP only. RAR5 and 7z always store UTF-8 names natively; tar/gz have no
 * formal filename encoding but UTF-8 is the de-facto modern default.
 */

/** Numeric code pages accepted by 7-Zip's `-mcp=` switch. `null` means "no override". */
export type ZipFilenameCodePage = 932 | 936 | 949 | 950 | 1252 | null;

export interface ZipFilenameEncodingDetection {
    /** Pass to `7z -mcp=N` for reads. `null` means leave 7-Zip default (already handles flagged UTF-8 entries). */
    codePage: ZipFilenameCodePage;
    /** Short rationale string for structured logs ("all-utf8-or-ascii", "cp932:valid=12,bonus=6,…", etc.). */
    reason: string;
    /** Total central-directory entries inspected. */
    inspectedCount: number;
    /** How many entries declared their names as UTF-8 (GPF bit 11). */
    utf8FlaggedCount: number;
    /** How many entries carried an Info-ZIP Unicode Path Extra Field (0x7075). */
    unicodePathExtraCount: number;
    /** How many entries needed legacy decoding (non-ASCII bytes, no UTF-8 flag, no 0x7075). */
    legacyCandidateCount: number;
    /** True when central-directory parsing was skipped — 7-Zip default behaviour will be used. */
    skipped: boolean;
}

interface CodePageScore {
    codePage: Exclude<ZipFilenameCodePage, null>;
    score: number;
    reason: string;
}

/**
 * Run the heuristic. Never throws — failure paths return `{ codePage: null, skipped: true }`.
 */
export async function detectZipFilenameCodePage(
    filePath: string
): Promise<ZipFilenameEncodingDetection> {
    let cdResult;
    try {
        cdResult = await readZipCentralDirectoryNames(filePath);
    } catch (err) {
        logger.warn('zipFilenameEncoding: unexpected CD read failure', {
            filePath,
            error: err instanceof Error ? err.message : String(err)
        });
        return buildSkippedResult('cd-read-threw');
    }

    if (cdResult.skipReason) {
        return buildSkippedResult(`cd-parse-skipped:${cdResult.skipReason}`);
    }
    if (cdResult.entries.length === 0) {
        return {
            codePage: null,
            reason: 'empty-cd',
            inspectedCount: 0,
            utf8FlaggedCount: 0,
            unicodePathExtraCount: 0,
            legacyCandidateCount: 0,
            skipped: false
        };
    }

    let utf8FlaggedCount = 0;
    let unicodePathExtraCount = 0;
    /** Filename byte buffers that need legacy decoding (non-ASCII + no UTF-8 hints). */
    const legacyNames: Buffer[] = [];

    for (const entry of cdResult.entries) {
        if (entry.hasUtf8Flag) utf8FlaggedCount++;
        if (entry.unicodePathExtraField !== undefined) unicodePathExtraCount++;

        const hasNonAscii = entry.rawNameBytes.some((b) => b >= 0x80);
        const needsLegacyDecode =
            hasNonAscii &&
            !entry.hasUtf8Flag &&
            entry.unicodePathExtraField === undefined;
        if (needsLegacyDecode) {
            legacyNames.push(entry.rawNameBytes);
        }
    }

    const inspectedCount = cdResult.entries.length;
    const legacyCandidateCount = legacyNames.length;

    if (legacyCandidateCount === 0) {
        return {
            codePage: null,
            reason: 'all-utf8-or-ascii',
            inspectedCount,
            utf8FlaggedCount,
            unicodePathExtraCount,
            legacyCandidateCount,
            skipped: false
        };
    }

    const concatenated = Buffer.concat(legacyNames);

    // Lucky path: legacy bytes are coincidentally valid UTF-8 (a common bug on Linux `zip` —
    // it writes UTF-8 names but forgets to flip GPF bit 11). 7-Zip's default decoder will
    // already produce correct names in that scenario, so we don't override.
    if (decodesAsUtf8(concatenated)) {
        return {
            codePage: null,
            reason: 'legacy-bytes-are-valid-utf8',
            inspectedCount,
            utf8FlaggedCount,
            unicodePathExtraCount,
            legacyCandidateCount,
            skipped: false
        };
    }

    // Strong signal: cross-check decoded audio filenames against `settings.songFilename` from
    // a `.adofai` JSON inside the archive. The `.adofai` is reliably UTF-8 so its strings are
    // ground truth, and at most one candidate codec will reproduce them from the raw bytes.
    try {
        const contentMatch = await detectZipFilenameCodePageByContent(filePath, cdResult.entries);
        if (contentMatch) {
            logger.debug('zipFilenameEncoding: content-aware match', {
                filePath,
                codePage: contentMatch.codePage,
                score: contentMatch.score,
                reason: contentMatch.reason,
                perCodec: contentMatch.perCodec
            });
            return {
                codePage: contentMatch.codePage,
                reason: `content-aware:${contentMatch.reason}`,
                inspectedCount,
                utf8FlaggedCount,
                unicodePathExtraCount,
                legacyCandidateCount,
                skipped: false
            };
        }
    } catch (err) {
        logger.warn('zipFilenameEncoding: content-aware detection threw; falling back to byte-pattern', {
            filePath,
            error: err instanceof Error ? err.message : String(err)
        });
    }

    // Byte-pattern fallback. Order matches the player-base distribution so identical scores
    // (which happens often for short CJK names — CP936 / CP949 byte ranges genuinely alias)
    // resolve to the most-likely encoding first.
    const scores: CodePageScore[] = [
        scoreEucKr(concatenated),
        scoreGbk(concatenated),
        scoreBig5(concatenated),
        scoreShiftJis(concatenated),
        scoreCp1252(concatenated)
    ];
    // Stable sort by score desc; ties retain insertion order → preserves player-base ranking.
    scores.sort((a, b) => b.score - a.score);
    const winner = scores[0];

    return {
        codePage: winner.codePage,
        reason: `byte-pattern:${winner.reason} (top of ${scores.map((s) => `${s.codePage}:${s.score}`).join(',')})`,
        inspectedCount,
        utf8FlaggedCount,
        unicodePathExtraCount,
        legacyCandidateCount,
        skipped: false
    };
}

function buildSkippedResult(reason: string): ZipFilenameEncodingDetection {
    return {
        codePage: null,
        reason,
        inspectedCount: 0,
        utf8FlaggedCount: 0,
        unicodePathExtraCount: 0,
        legacyCandidateCount: 0,
        skipped: true
    };
}

function decodesAsUtf8(buf: Buffer): boolean {
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(buf);
        return true;
    } catch {
        return false;
    }
}

/**
 * CP932 (Shift-JIS).
 *  - Half-width katakana single-byte block: 0xA1..0xDF.
 *  - Double-byte: lead 0x81..0x9F or 0xE0..0xFC, trail 0x40..0x7E or 0x80..0xFC.
 *  - Bonus rows: hiragana (0x82 0x9F..0xF1), katakana (0x83 0x40..0x96), JIS L1/L2 kanji.
 */
function scoreShiftJis(buf: Buffer): CodePageScore {
    let valid = 0;
    let bonus = 0;
    let invalid = 0;
    let i = 0;
    while (i < buf.length) {
        const b = buf[i];
        if (b < 0x80) { i++; continue; }
        if (b >= 0xa1 && b <= 0xdf) { valid++; i++; continue; }
        const isLead = (b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc);
        if (isLead && i + 1 < buf.length) {
            const t = buf[i + 1];
            const isTrail = (t >= 0x40 && t <= 0x7e) || (t >= 0x80 && t <= 0xfc);
            if (isTrail) {
                valid++;
                if (b === 0x82 && t >= 0x9f && t <= 0xf1) bonus += 3;
                else if (b === 0x83 && t >= 0x40 && t <= 0x96) bonus += 3;
                else if (b >= 0x88 && b <= 0x9f) bonus += 1;
                else if (b >= 0xe0 && b <= 0xea) bonus += 1;
                i += 2;
                continue;
            }
        }
        invalid++;
        i++;
    }
    return {
        codePage: 932,
        score: valid * 2 + bonus - invalid * 5,
        reason: `cp932:valid=${valid},bonus=${bonus},invalid=${invalid}`
    };
}

/**
 * CP936 (GBK).
 *  - Lead 0x81..0xFE, trail 0x40..0xFE except 0x7F.
 *  - Bonus: GB2312-style "common hanzi" block (lead 0xB0..0xF7 with trail 0xA1..0xFE).
 */
function scoreGbk(buf: Buffer): CodePageScore {
    let valid = 0;
    let bonus = 0;
    let invalid = 0;
    let i = 0;
    while (i < buf.length) {
        const b = buf[i];
        if (b < 0x80) { i++; continue; }
        const isLead = b >= 0x81 && b <= 0xfe;
        if (isLead && i + 1 < buf.length) {
            const t = buf[i + 1];
            const isTrail = t >= 0x40 && t <= 0xfe && t !== 0x7f;
            if (isTrail) {
                valid++;
                if (b >= 0xb0 && b <= 0xf7 && t >= 0xa1 && t <= 0xfe) bonus += 2;
                i += 2;
                continue;
            }
        }
        invalid++;
        i++;
    }
    return {
        codePage: 936,
        score: valid * 2 + bonus - invalid * 5,
        reason: `cp936:valid=${valid},bonus=${bonus},invalid=${invalid}`
    };
}

/**
 * CP949 (EUC-KR / Unified Hangul Code).
 *  - Lead 0x81..0xFE, trail 0x41..0xFE.
 *  - Bonus: "common Hangul" block (lead 0xB0..0xC8 with trail 0xA1..0xFE).
 */
function scoreEucKr(buf: Buffer): CodePageScore {
    let valid = 0;
    let bonus = 0;
    let invalid = 0;
    let i = 0;
    while (i < buf.length) {
        const b = buf[i];
        if (b < 0x80) { i++; continue; }
        const isLead = b >= 0x81 && b <= 0xfe;
        if (isLead && i + 1 < buf.length) {
            const t = buf[i + 1];
            const isTrail = t >= 0x41 && t <= 0xfe;
            if (isTrail) {
                valid++;
                if (b >= 0xb0 && b <= 0xc8 && t >= 0xa1 && t <= 0xfe) bonus += 2;
                i += 2;
                continue;
            }
        }
        invalid++;
        i++;
    }
    return {
        codePage: 949,
        score: valid * 2 + bonus - invalid * 5,
        reason: `cp949:valid=${valid},bonus=${bonus},invalid=${invalid}`
    };
}

/**
 * CP950 (Big5, Traditional Chinese).
 *  - Lead 0xA1..0xFE, trail 0x40..0x7E or 0xA1..0xFE.
 *  - Bonus: BIG5 frequent-hanzi block (lead 0xA4..0xC6).
 */
function scoreBig5(buf: Buffer): CodePageScore {
    let valid = 0;
    let bonus = 0;
    let invalid = 0;
    let i = 0;
    while (i < buf.length) {
        const b = buf[i];
        if (b < 0x80) { i++; continue; }
        const isLead = b >= 0xa1 && b <= 0xfe;
        if (isLead && i + 1 < buf.length) {
            const t = buf[i + 1];
            const isTrail = (t >= 0x40 && t <= 0x7e) || (t >= 0xa1 && t <= 0xfe);
            if (isTrail) {
                valid++;
                if (b >= 0xa4 && b <= 0xc6) bonus += 2;
                i += 2;
                continue;
            }
        }
        invalid++;
        i++;
    }
    return {
        codePage: 950,
        score: valid * 2 + bonus - invalid * 5,
        reason: `cp950:valid=${valid},bonus=${bonus},invalid=${invalid}`
    };
}

/**
 * CP1252 (Windows Western European). Single-byte; only a handful of slots are unmapped.
 * Scored conservatively so CJK code pages win ties on CJK-shaped input.
 */
function scoreCp1252(buf: Buffer): CodePageScore {
    let valid = 0;
    let invalid = 0;
    for (let i = 0; i < buf.length; i++) {
        const b = buf[i];
        if (b < 0x80) continue;
        if (b === 0x81 || b === 0x8d || b === 0x8f || b === 0x90 || b === 0x9d) {
            invalid++;
        } else {
            valid++;
        }
    }
    return {
        codePage: 1252,
        score: valid - invalid * 3,
        reason: `cp1252:valid=${valid},invalid=${invalid}`
    };
}
