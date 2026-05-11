import fs from 'fs';
import path from 'path';
import iconv from 'iconv-lite';
import { detectZipFilenameCodePage, type ZipFilenameCodePage } from './zipFilenameEncoding.js';
import { readZipCentralDirectoryNames } from './zipCentralDirectory.js';

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CD_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const EOCD_FIXED_SIZE = 22;
const CD_FIXED_HEADER_SIZE = 46;
const LOCAL_FIXED_HEADER_SIZE = 30;
const EXTRA_FIELD_HEADER_SIZE = 4;
const MAX_ZIP_COMMENT_SIZE = 0xffff;

const GPF_BIT_UTF8 = 0x0800;
const GPF_BIT_ENCRYPTED = 0x0001;
const GPF_BIT_DATA_DESCRIPTOR = 0x0008;

const INFO_ZIP_UNICODE_PATH_HEADER_ID = 0x7075;

/** Compression methods we stream-copy without re-inflating. */
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

export type ZipUtf8RewriteSkipReason =
    | 'NOT_ZIP_FILE'
    | 'CD_PARSE'
    | 'ZIP64'
    | 'ENCRYPTED'
    | 'DATA_DESCRIPTOR'
    | 'UNSUPPORTED_COMPRESSION'
    | 'LOCAL_HEADER_MISMATCH'
    | 'IO_ERROR'
    | 'EMPTY_ARCHIVE';

export type ZipUtf8RewriteResult =
    | { ok: true; entriesWritten: number; detectionReason: string; codePage: ZipFilenameCodePage }
    | { ok: false; reason: ZipUtf8RewriteSkipReason; detail?: string };

interface CdFullEntry {
    /** Filled during rewrite: byte offset of this entry’s local header in the output file. */
    _rewriteLocalOffset?: number;
    rawNameBytes: Buffer;
    hasUtf8Flag: boolean;
    unicodePathExtraField?: string;
    gpf: number;
    compressionMethod: number;
    crc32: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
    modTime: number;
    modDate: number;
    versionMadeBy: number;
    versionNeededToExtract: number;
    diskNumberStart: number;
    internalFileAttributes: number;
    externalFileAttributes: number;
    cdExtraField: Buffer;
    fileComment: Buffer;
}

function codecForCodePage(cp: ZipFilenameCodePage): string | null {
    if (cp === null) return null;
    const m: Record<Exclude<ZipFilenameCodePage, null>, string> = {
        932: 'shift_jis',
        936: 'cp936',
        949: 'cp949',
        950: 'big5',
        1252: 'cp1252',
    };
    return m[cp];
}

function parseUnicodePathExtra(extra: Buffer): string | undefined {
    let ex = 0;
    while (ex + EXTRA_FIELD_HEADER_SIZE <= extra.length) {
        const headerId = extra.readUInt16LE(ex);
        const dataSize = extra.readUInt16LE(ex + 2);
        const dataStart = ex + EXTRA_FIELD_HEADER_SIZE;
        const dataEnd = dataStart + dataSize;
        if (dataEnd > extra.length) break;
        if (headerId === INFO_ZIP_UNICODE_PATH_HEADER_ID && dataSize >= 5) {
            const version = extra.readUInt8(dataStart);
            if (version === 1) {
                try {
                    return new TextDecoder('utf-8', { fatal: true }).decode(extra.subarray(dataStart + 5, dataEnd));
                } catch {
                    /* ignore */
                }
            }
        }
        ex = dataEnd;
    }
    return undefined;
}

function strip7075FromExtra(extra: Buffer): Buffer {
    const parts: Buffer[] = [];
    let o = 0;
    while (o + EXTRA_FIELD_HEADER_SIZE <= extra.length) {
        const id = extra.readUInt16LE(o);
        const sz = extra.readUInt16LE(o + 2);
        const end = o + 4 + sz;
        if (end > extra.length) break;
        if (id !== INFO_ZIP_UNICODE_PATH_HEADER_ID) {
            parts.push(extra.subarray(o, end));
        }
        o = end;
    }
    return Buffer.concat(parts);
}

function decodeEntryPathUtf8Bytes(
    e: Pick<CdFullEntry, 'rawNameBytes' | 'hasUtf8Flag' | 'unicodePathExtraField'>,
    codec: string | null
): Buffer {
    if (e.unicodePathExtraField !== undefined) {
        return Buffer.from(e.unicodePathExtraField.normalize('NFC'), 'utf8');
    }
    if (e.hasUtf8Flag) {
        try {
            new TextDecoder('utf-8', { fatal: true }).decode(e.rawNameBytes);
            return Buffer.from(e.rawNameBytes);
        } catch {
            /* fall through — mis-flagged UTF-8 */
        }
    }
    if (codec) {
        const s = iconv.decode(e.rawNameBytes, codec);
        return Buffer.from(s.normalize('NFC'), 'utf8');
    }
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(e.rawNameBytes);
        return Buffer.from(e.rawNameBytes);
    } catch {
        const s = iconv.decode(e.rawNameBytes, 'latin1');
        return Buffer.from(s.normalize('NFC'), 'utf8');
    }
}

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

function readFullCdEntries(cd: Buffer, expectedCount: number): CdFullEntry[] | 'CD_SIGNATURE_MISMATCH' | 'TRUNCATED' {
    const entries: CdFullEntry[] = [];
    let off = 0;
    while (off + CD_FIXED_HEADER_SIZE <= cd.length) {
        if (cd.readUInt32LE(off) !== CD_SIGNATURE) {
            return 'CD_SIGNATURE_MISMATCH';
        }
        const versionMadeBy = cd.readUInt16LE(off + 4);
        const versionNeededToExtract = cd.readUInt16LE(off + 6);
        const gpf = cd.readUInt16LE(off + 8);
        const compressionMethod = cd.readUInt16LE(off + 10);
        const modTime = cd.readUInt16LE(off + 12);
        const modDate = cd.readUInt16LE(off + 14);
        const crc32 = cd.readUInt32LE(off + 16);
        const compressedSize = cd.readUInt32LE(off + 20);
        const uncompressedSize = cd.readUInt32LE(off + 24);
        const nameLen = cd.readUInt16LE(off + 28);
        const extraLen = cd.readUInt16LE(off + 30);
        const commentLen = cd.readUInt16LE(off + 32);
        const diskNumberStart = cd.readUInt16LE(off + 34);
        const internalFileAttributes = cd.readUInt16LE(off + 36);
        const externalFileAttributes = cd.readUInt32LE(off + 38);
        const localHeaderOffset = cd.readUInt32LE(off + 42);

        const nameStart = off + CD_FIXED_HEADER_SIZE;
        const extraStart = nameStart + nameLen;
        const commentStart = extraStart + extraLen;
        const next = commentStart + commentLen;
        if (next > cd.length) {
            return 'TRUNCATED';
        }

        const rawNameBytes = Buffer.from(cd.subarray(nameStart, extraStart));
        const cdExtraField = Buffer.from(cd.subarray(extraStart, commentStart));
        const fileComment = Buffer.from(cd.subarray(commentStart, next));

        const hasUtf8Flag = (gpf & GPF_BIT_UTF8) !== 0;
        const unicodePathExtraField = parseUnicodePathExtra(cdExtraField);

        entries.push({
            rawNameBytes,
            hasUtf8Flag,
            unicodePathExtraField,
            gpf,
            compressionMethod,
            crc32,
            compressedSize,
            uncompressedSize,
            localHeaderOffset,
            modTime,
            modDate,
            versionMadeBy,
            versionNeededToExtract,
            diskNumberStart,
            internalFileAttributes,
            externalFileAttributes,
            cdExtraField,
            fileComment,
        });
        off = next;
        if (entries.length >= expectedCount) break;
    }
    if (entries.length !== expectedCount) {
        return 'TRUNCATED';
    }
    return entries;
}

function hasZip64Sizes(e: CdFullEntry): boolean {
    return (
        e.localHeaderOffset === 0xffffffff ||
        e.compressedSize === 0xffffffff ||
        e.uncompressedSize === 0xffffffff
    );
}

function hasZip64Extra(extra: Buffer): boolean {
    let o = 0;
    while (o + EXTRA_FIELD_HEADER_SIZE <= extra.length) {
        const id = extra.readUInt16LE(o);
        if (id === 0x0001) return true;
        const sz = extra.readUInt16LE(o + 2);
        o += 4 + sz;
    }
    return false;
}

function buildLocalHeader(params: {
    versionNeeded: number;
    gpf: number;
    method: number;
    modTime: number;
    modDate: number;
    crc32: number;
    compressedSize: number;
    uncompressedSize: number;
    fileName: Buffer;
    extraField: Buffer;
}): Buffer {
    const nameLen = params.fileName.length;
    const extraLen = params.extraField.length;
    const buf = Buffer.allocUnsafe(LOCAL_FIXED_HEADER_SIZE + nameLen + extraLen);
    buf.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
    buf.writeUInt16LE(params.versionNeeded, 4);
    buf.writeUInt16LE(params.gpf, 6);
    buf.writeUInt16LE(params.method, 8);
    buf.writeUInt16LE(params.modTime, 10);
    buf.writeUInt16LE(params.modDate, 12);
    buf.writeUInt32LE(params.crc32 >>> 0, 14);
    buf.writeUInt32LE(params.compressedSize >>> 0, 18);
    buf.writeUInt32LE(params.uncompressedSize >>> 0, 22);
    buf.writeUInt16LE(nameLen, 26);
    buf.writeUInt16LE(extraLen, 28);
    params.fileName.copy(buf, 30);
    params.extraField.copy(buf, 30 + nameLen);
    return buf;
}

function buildCdHeader(params: {
    versionMadeBy: number;
    versionNeeded: number;
    gpf: number;
    method: number;
    modTime: number;
    modDate: number;
    crc32: number;
    compressedSize: number;
    uncompressedSize: number;
    diskNumberStart: number;
    internalAttrs: number;
    externalAttrs: number;
    localHeaderOffset: number;
    fileName: Buffer;
    extraField: Buffer;
    fileComment: Buffer;
}): Buffer {
    const nameLen = params.fileName.length;
    const extraLen = params.extraField.length;
    const commentLen = params.fileComment.length;
    const buf = Buffer.allocUnsafe(CD_FIXED_HEADER_SIZE + nameLen + extraLen + commentLen);
    buf.writeUInt32LE(CD_SIGNATURE, 0);
    buf.writeUInt16LE(params.versionMadeBy, 4);
    buf.writeUInt16LE(params.versionNeeded, 6);
    buf.writeUInt16LE(params.gpf, 8);
    buf.writeUInt16LE(params.method, 10);
    buf.writeUInt16LE(params.modTime, 12);
    buf.writeUInt16LE(params.modDate, 14);
    buf.writeUInt32LE(params.crc32 >>> 0, 16);
    buf.writeUInt32LE(params.compressedSize >>> 0, 20);
    buf.writeUInt32LE(params.uncompressedSize >>> 0, 24);
    buf.writeUInt16LE(nameLen, 28);
    buf.writeUInt16LE(extraLen, 30);
    buf.writeUInt16LE(commentLen, 32);
    buf.writeUInt16LE(params.diskNumberStart, 34);
    buf.writeUInt16LE(params.internalAttrs, 36);
    buf.writeUInt32LE(params.externalAttrs, 38);
    buf.writeUInt32LE(params.localHeaderOffset >>> 0, 42);
    params.fileName.copy(buf, 46);
    params.extraField.copy(buf, 46 + nameLen);
    params.fileComment.copy(buf, 46 + nameLen + extraLen);
    return buf;
}

function buildEocd(params: {
    diskNumber: number;
    cdStartDisk: number;
    diskEntryCount: number;
    totalEntryCount: number;
    cdSize: number;
    cdOffset: number;
    comment: Buffer;
}): Buffer {
    const buf = Buffer.allocUnsafe(EOCD_FIXED_SIZE + params.comment.length);
    buf.writeUInt32LE(EOCD_SIGNATURE, 0);
    buf.writeUInt16LE(params.diskNumber, 4);
    buf.writeUInt16LE(params.cdStartDisk, 6);
    buf.writeUInt16LE(params.diskEntryCount, 8);
    buf.writeUInt16LE(params.totalEntryCount, 10);
    buf.writeUInt32LE(params.cdSize >>> 0, 12);
    buf.writeUInt32LE(params.cdOffset >>> 0, 16);
    buf.writeUInt16LE(params.comment.length, 20);
    params.comment.copy(buf, 22);
    return buf;
}

/**
 * Rebuilds a `.zip` so every entry name is stored as **UTF-8** with **GPF bit 11** set, using the
 * same {@link detectZipFilenameCodePage} pipeline as reads. Compressed payloads are copied
 * byte-for-byte (no inflate/deflate).
 *
 * Unsupported (returns `{ ok: false }`): ZIP64-sized records, encryption, data descriptors,
 * non-deflate/store compression, trailing junk that cannot be aligned to local headers.
 */
export async function rewriteZipFilenamesToUtf8(
    inputPath: string,
    outputPath: string,
    signal?: AbortSignal
): Promise<ZipUtf8RewriteResult> {
    let inFd: fs.promises.FileHandle | undefined;
    let outFd: fs.promises.FileHandle | undefined;
    try {
        inFd = await fs.promises.open(inputPath, 'r');
        const { size: fileSize } = await inFd.stat();
        if (fileSize < EOCD_FIXED_SIZE) {
            return { ok: false, reason: 'CD_PARSE', detail: 'file too small' };
        }

        const eocd = await findEocdOffset(inFd, fileSize);
        if (!eocd) {
            return { ok: false, reason: 'CD_PARSE', detail: 'no EOCD' };
        }
        const { tail, eocdOffsetInTail } = eocd;
        const eocdOffset = fileSize - tail.length + eocdOffsetInTail;

        const diskEntryCount = tail.readUInt16LE(eocdOffsetInTail + 8);
        const totalEntryCount = tail.readUInt16LE(eocdOffsetInTail + 10);
        const cdSize = tail.readUInt32LE(eocdOffsetInTail + 12);
        const cdOffset = tail.readUInt32LE(eocdOffsetInTail + 16);
        const commentLen = tail.readUInt16LE(eocdOffsetInTail + 20);
        const comment = Buffer.from(tail.subarray(eocdOffsetInTail + 22, eocdOffsetInTail + 22 + commentLen));

        if (
            cdOffset === 0xffffffff ||
            cdSize === 0xffffffff ||
            diskEntryCount === 0xffff ||
            totalEntryCount === 0xffff
        ) {
            return { ok: false, reason: 'ZIP64' };
        }
        if (cdSize === 0 || cdOffset + cdSize > fileSize) {
            return { ok: false, reason: 'CD_PARSE', detail: 'invalid CD span' };
        }
        if (diskEntryCount !== totalEntryCount) {
            return { ok: false, reason: 'CD_PARSE', detail: 'multi-disk not supported' };
        }

        const cdBuf = Buffer.alloc(cdSize);
        await inFd.read(cdBuf, 0, cdSize, cdOffset);

        const parsed = readFullCdEntries(cdBuf, totalEntryCount);
        if (parsed === 'CD_SIGNATURE_MISMATCH' || parsed === 'TRUNCATED') {
            return { ok: false, reason: 'CD_PARSE', detail: parsed };
        }
        const entries = parsed;
        if (entries.length === 0) {
            return { ok: false, reason: 'EMPTY_ARCHIVE' };
        }
        if (entries.length !== totalEntryCount) {
            return { ok: false, reason: 'CD_PARSE', detail: 'entry count mismatch' };
        }

        for (const e of entries) {
            if ((e.gpf & GPF_BIT_ENCRYPTED) !== 0) {
                return { ok: false, reason: 'ENCRYPTED' };
            }
            if ((e.gpf & GPF_BIT_DATA_DESCRIPTOR) !== 0) {
                return { ok: false, reason: 'DATA_DESCRIPTOR' };
            }
            if (e.compressionMethod !== METHOD_STORE && e.compressionMethod !== METHOD_DEFLATE) {
                return { ok: false, reason: 'UNSUPPORTED_COMPRESSION', detail: String(e.compressionMethod) };
            }
            if (hasZip64Sizes(e) || hasZip64Extra(e.cdExtraField)) {
                return { ok: false, reason: 'ZIP64' };
            }
        }

        const detection = await detectZipFilenameCodePage(inputPath);
        const codec = codecForCodePage(detection.codePage);

        const sorted = [...entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);

        await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
        outFd = await fs.promises.open(outputPath, 'w');
        let outPos = 0;

        const writeBuf = async (b: Buffer) => {
            signal?.throwIfAborted();
            await outFd!.write(b, 0, b.length, outPos);
            outPos += b.length;
        };

        const copyRange = async (start: number, len: number) => {
            const chunk = 4 * 1024 * 1024;
            let left = len;
            let pos = start;
            while (left > 0) {
                signal?.throwIfAborted();
                const n = Math.min(chunk, left);
                const buf = Buffer.allocUnsafe(n);
                await inFd!.read(buf, 0, n, pos);
                await outFd!.write(buf, 0, n, outPos);
                outPos += n;
                pos += n;
                left -= n;
            }
        };

        let nextExpectedReadPos = 0;

        for (const cdEntry of sorted) {
            if (cdEntry.localHeaderOffset > nextExpectedReadPos) {
                const gap = cdEntry.localHeaderOffset - nextExpectedReadPos;
                await copyRange(nextExpectedReadPos, gap);
            }

            const lhBuf = Buffer.allocUnsafe(LOCAL_FIXED_HEADER_SIZE);
            await inFd.read(lhBuf, 0, LOCAL_FIXED_HEADER_SIZE, cdEntry.localHeaderOffset);
            if (lhBuf.readUInt32LE(0) !== LOCAL_HEADER_SIGNATURE) {
                return { ok: false, reason: 'LOCAL_HEADER_MISMATCH', detail: `at ${cdEntry.localHeaderOffset}` };
            }
            const locNameLen = lhBuf.readUInt16LE(26);
            const locExtraLen = lhBuf.readUInt16LE(28);
            const locName = Buffer.allocUnsafe(locNameLen);
            const locExtra = Buffer.allocUnsafe(locExtraLen);
            const locNameStart = cdEntry.localHeaderOffset + LOCAL_FIXED_HEADER_SIZE;
            await inFd.read(locName, 0, locNameLen, locNameStart);
            await inFd.read(locExtra, 0, locExtraLen, locNameStart + locNameLen);
            if (!locName.equals(cdEntry.rawNameBytes)) {
                return {
                    ok: false,
                    reason: 'LOCAL_HEADER_MISMATCH',
                    detail: 'local vs central filename bytes differ',
                };
            }

            const newUtf8Name = decodeEntryPathUtf8Bytes(cdEntry, codec);
            const newLocalExtra = strip7075FromExtra(locExtra);
            const newGpf = cdEntry.gpf | GPF_BIT_UTF8;
            const versionNeeded = Math.max(cdEntry.versionNeededToExtract, 20);

            const localHeader = buildLocalHeader({
                versionNeeded,
                gpf: newGpf,
                method: cdEntry.compressionMethod,
                modTime: cdEntry.modTime,
                modDate: cdEntry.modDate,
                crc32: cdEntry.crc32,
                compressedSize: cdEntry.compressedSize,
                uncompressedSize: cdEntry.uncompressedSize,
                fileName: newUtf8Name,
                extraField: newLocalExtra,
            });

            const payloadStart = cdEntry.localHeaderOffset + LOCAL_FIXED_HEADER_SIZE + locNameLen + locExtraLen;
            const payloadLen = cdEntry.compressedSize;

            cdEntry._rewriteLocalOffset = outPos;
            await writeBuf(localHeader);
            await copyRange(payloadStart, payloadLen);

            nextExpectedReadPos = payloadStart + payloadLen;
        }

        if (nextExpectedReadPos < cdOffset) {
            await copyRange(nextExpectedReadPos, cdOffset - nextExpectedReadPos);
        } else if (nextExpectedReadPos > cdOffset) {
            return { ok: false, reason: 'CD_PARSE', detail: 'local file data overlaps central directory' };
        }

        const newCdParts: Buffer[] = [];
        for (const cdEntry of entries) {
            const newUtf8Name = decodeEntryPathUtf8Bytes(cdEntry, codec);
            const newCdExtra = strip7075FromExtra(cdEntry.cdExtraField);
            const newGpf = cdEntry.gpf | GPF_BIT_UTF8;
            const versionNeeded = Math.max(cdEntry.versionNeededToExtract, 20);
            const newLocalOff = cdEntry._rewriteLocalOffset;
            if (newLocalOff === undefined) {
                return { ok: false, reason: 'CD_PARSE', detail: 'internal: missing remapped local offset' };
            }

            newCdParts.push(
                buildCdHeader({
                    versionMadeBy: cdEntry.versionMadeBy,
                    versionNeeded,
                    gpf: newGpf,
                    method: cdEntry.compressionMethod,
                    modTime: cdEntry.modTime,
                    modDate: cdEntry.modDate,
                    crc32: cdEntry.crc32,
                    compressedSize: cdEntry.compressedSize,
                    uncompressedSize: cdEntry.uncompressedSize,
                    diskNumberStart: cdEntry.diskNumberStart,
                    internalAttrs: cdEntry.internalFileAttributes,
                    externalAttrs: cdEntry.externalFileAttributes,
                    localHeaderOffset: newLocalOff,
                    fileName: newUtf8Name,
                    extraField: newCdExtra,
                    fileComment: cdEntry.fileComment,
                })
            );
        }

        const newCd = Buffer.concat(newCdParts);
        const newCdOffset = outPos;
        await writeBuf(newCd);

        const eocdBuf = buildEocd({
            diskNumber: 0,
            cdStartDisk: 0,
            diskEntryCount: totalEntryCount,
            totalEntryCount,
            cdSize: newCd.length,
            cdOffset: newCdOffset,
            comment,
        });
        await writeBuf(eocdBuf);

        return {
            ok: true,
            entriesWritten: entries.length,
            detectionReason: detection.reason,
            codePage: detection.codePage,
        };
    } catch (err) {
        if (signal?.aborted) {
            throw err;
        }
        return {
            ok: false,
            reason: 'IO_ERROR',
            detail: err instanceof Error ? err.message : String(err),
        };
    } finally {
        try {
            await outFd?.close();
        } catch {
            /* */
        }
        try {
            await inFd?.close();
        } catch {
            /* */
        }
    }
}

/**
 * Fast check: archive already has UTF-8 names everywhere (bit 11 and/or 0x7075 on every non-ASCII
 * path, or ASCII-only). Used to skip an expensive rewrite + second full-file write.
 */
export async function zipArchiveFilenamesAlreadyUtf8Clean(filePath: string): Promise<boolean> {
    const cd = await readZipCentralDirectoryNames(filePath);
    if (cd.skipReason || cd.entries.length === 0) {
        return false;
    }
    for (const e of cd.entries) {
        const nonAscii = e.rawNameBytes.some((b) => b >= 0x80);
        if (!nonAscii) continue;
        if (e.hasUtf8Flag || e.unicodePathExtraField !== undefined) {
            continue;
        }
        return false;
    }
    return true;
}
