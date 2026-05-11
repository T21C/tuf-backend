import fs from 'fs';

/**
 * Minimal pure-Node ZIP central-directory reader used by {@link ./zipFilenameEncoding.ts}
 * to recover the original filename byte payload + encoding hints from each entry.
 *
 * 7-Zip's `l` listing only ever yields *decoded* names (correct or mojibake depending
 * on `-mcu=on` / `-mcp=`). For encoding detection we need the *raw* bytes the archive
 * stored, plus the General Purpose Bit Flag (bit 11 = "names are UTF-8") and any
 * Info-ZIP Unicode Path Extra Field (0x7075) that some tools embed as a safety net.
 *
 * Scope intentionally narrow:
 *  - No decompression, no data offsets — we only parse central-directory headers.
 *  - ZIP64 / encrypted-central-directory archives are skipped and reported via
 *    {@link ZipCentralDirectoryReadResult.skipReason}; callers should fall back to
 *    7-Zip's default behaviour for these.
 *  - We never throw on malformed input — every failure path returns `skipReason`.
 */

/** PKZIP signatures (little-endian on disk). */
const EOCD_SIGNATURE = 0x06054b50;
const CD_SIGNATURE = 0x02014b50;

/** Fixed sizes from the PKWARE ZIP APPNOTE. */
const EOCD_FIXED_SIZE = 22;
const CD_FIXED_HEADER_SIZE = 46;
const EXTRA_FIELD_HEADER_SIZE = 4;
const MAX_ZIP_COMMENT_SIZE = 0xffff;

/** General Purpose Bit Flag bit 11 — "language encoding flag" / EFS (UTF-8). */
const GPF_BIT_UTF8 = 0x0800;

/** Header ID for the Info-ZIP Unicode Path Extra Field (PKWARE APPNOTE section 4.6.9). */
const INFO_ZIP_UNICODE_PATH_HEADER_ID = 0x7075;

export interface ZipCentralDirectoryEntry {
    /** Raw filename bytes as stored in the central directory header (no decoding applied). */
    rawNameBytes: Buffer;
    /** True when GPF bit 11 is set — entry promises its filename bytes are UTF-8. */
    hasUtf8Flag: boolean;
    /** Decoded UTF-8 name from the 0x7075 extra field, when present and parseable. */
    unicodePathExtraField?: string;
}

export type ZipCentralDirectorySkipReason =
    | 'NO_EOCD'
    | 'ZIP64'
    | 'TRUNCATED'
    | 'CD_SIGNATURE_MISMATCH'
    | 'IO_ERROR';

export interface ZipCentralDirectoryReadResult {
    entries: ZipCentralDirectoryEntry[];
    /** Present when parsing aborted partway; callers should not assume `entries` is complete. */
    skipReason?: ZipCentralDirectorySkipReason;
}

/**
 * Walk the tail of the file backwards to locate the EOCD record. The comment after the
 * EOCD can be up to 64 KiB, so we cap the read window at `EOCD_FIXED_SIZE + 0xFFFF`.
 */
async function findEocdOffset(
    fd: fs.promises.FileHandle,
    fileSize: number
): Promise<{ tail: Buffer; eocdOffsetInTail: number } | null> {
    const tailSize = Math.min(fileSize, EOCD_FIXED_SIZE + MAX_ZIP_COMMENT_SIZE);
    const tail = Buffer.alloc(tailSize);
    await fd.read(tail, 0, tailSize, fileSize - tailSize);
    for (let i = tailSize - EOCD_FIXED_SIZE; i >= 0; i--) {
        if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
            return { tail, eocdOffsetInTail: i };
        }
    }
    return null;
}

/**
 * Read the central directory of a `.zip` and return per-entry filename metadata.
 *
 * Never throws — IO / format problems surface as a non-empty {@link skipReason} with
 * a partial (possibly empty) entry list. Returned `Buffer` slices are independent
 * copies safe to retain after this function returns.
 */
export async function readZipCentralDirectoryNames(
    filePath: string
): Promise<ZipCentralDirectoryReadResult> {
    let fd: fs.promises.FileHandle | undefined;
    try {
        fd = await fs.promises.open(filePath, 'r');
        const { size: fileSize } = await fd.stat();
        if (fileSize < EOCD_FIXED_SIZE) {
            return { entries: [], skipReason: 'TRUNCATED' };
        }

        const eocd = await findEocdOffset(fd, fileSize);
        if (!eocd) {
            return { entries: [], skipReason: 'NO_EOCD' };
        }
        const { tail, eocdOffsetInTail } = eocd;

        const cdEntryCount = tail.readUInt16LE(eocdOffsetInTail + 10);
        const cdSize = tail.readUInt32LE(eocdOffsetInTail + 12);
        const cdOffset = tail.readUInt32LE(eocdOffsetInTail + 16);

        // ZIP64 sentinel values mean the real offsets live in a ZIP64 EOCD record we don't parse.
        if (cdOffset === 0xffffffff || cdSize === 0xffffffff || cdEntryCount === 0xffff) {
            return { entries: [], skipReason: 'ZIP64' };
        }
        if (cdSize === 0 || cdOffset + cdSize > fileSize) {
            return { entries: [], skipReason: 'TRUNCATED' };
        }

        const cd = Buffer.alloc(cdSize);
        await fd.read(cd, 0, cdSize, cdOffset);

        const entries: ZipCentralDirectoryEntry[] = [];
        let off = 0;
        while (off + CD_FIXED_HEADER_SIZE <= cd.length) {
            if (cd.readUInt32LE(off) !== CD_SIGNATURE) {
                return { entries, skipReason: 'CD_SIGNATURE_MISMATCH' };
            }
            const gpf = cd.readUInt16LE(off + 8);
            const nameLen = cd.readUInt16LE(off + 28);
            const extraLen = cd.readUInt16LE(off + 30);
            const commentLen = cd.readUInt16LE(off + 32);

            const nameStart = off + CD_FIXED_HEADER_SIZE;
            const extraStart = nameStart + nameLen;
            const commentStart = extraStart + extraLen;
            const next = commentStart + commentLen;
            if (next > cd.length) {
                return { entries, skipReason: 'TRUNCATED' };
            }

            const hasUtf8Flag = (gpf & GPF_BIT_UTF8) !== 0;
            // Copy the slice so the entry can outlive `cd`.
            const rawNameBytes = Buffer.from(cd.subarray(nameStart, extraStart));

            let unicodePathExtraField: string | undefined;
            let ex = extraStart;
            while (ex + EXTRA_FIELD_HEADER_SIZE <= commentStart) {
                const headerId = cd.readUInt16LE(ex);
                const dataSize = cd.readUInt16LE(ex + 2);
                const dataStart = ex + EXTRA_FIELD_HEADER_SIZE;
                const dataEnd = dataStart + dataSize;
                if (dataEnd > commentStart) break;
                // 0x7075 payload layout: version (1) + NameCRC32 (4) + UnicodeName (variable).
                if (headerId === INFO_ZIP_UNICODE_PATH_HEADER_ID && dataSize >= 5) {
                    const version = cd.readUInt8(dataStart);
                    if (version === 1) {
                        try {
                            unicodePathExtraField = new TextDecoder('utf-8', { fatal: true })
                                .decode(cd.subarray(dataStart + 5, dataEnd));
                        } catch {
                            // Malformed Unicode Path field — ignore and treat the entry as if it had none.
                        }
                    }
                }
                ex = dataEnd;
            }

            entries.push({ rawNameBytes, hasUtf8Flag, unicodePathExtraField });
            off = next;
            if (entries.length >= cdEntryCount) break;
        }
        return { entries };
    } catch {
        return { entries: [], skipReason: 'IO_ERROR' };
    } finally {
        try { await fd?.close(); } catch { /* best effort */ }
    }
}
