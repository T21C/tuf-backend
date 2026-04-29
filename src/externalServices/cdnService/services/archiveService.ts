import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { logger } from '@/server/services/core/LoggerService.js';
import { decodeMultipartFilename } from '@/misc/utils/multipartFilename.js';

/**
 * Archive service: a single chokepoint for read/list/extract/create operations
 * across all supported archive formats (.zip, .rar, .7z, .tar, .tar.gz/.tgz).
 *
 * Internally shells out to a system-installed 7z binary so we get one codepath
 * for every format (RAR, 7z, etc.). All operations honour an optional
 * AbortSignal so workspace teardown / SIGTERM kills the child process.
 */

export interface ArchiveEntry {
    /** Basename (last path segment) inside the archive. */
    name: string;
    /** POSIX-normalised path inside the archive (no leading slash). */
    relativePath: string;
    /**
     * `Path` from `7z l -slt` with only a leading slash trimmed — internal `\\` vs `/`
     * preserved. Used as the `7z x` file filter; some RARs only match the exact string
     * from the listing, while a POSIX-only path makes 7-Zip exit 2 even though a full
     * `7z x archive.rar` (no filter) works.
     */
    sevenZipSelector: string;
    /** Uncompressed size in bytes. */
    size: number;
    isDirectory: boolean;
}

export type SupportedArchiveExt = 'zip' | 'rar' | '7z' | 'tar' | 'gz' | 'tgz';

/**
 * Canonical descriptor of the original (source) archive for a CDN entry.
 *
 * Written into `CdnFile.metadata.originalArchive` (with a same-reference
 * `originalZip` alias for backward compatibility). Always include the original
 * filename — pre-migration rows only have `name` / `originalFilename`.
 */
export interface OriginalArchiveMeta {
    /** Display / on-disk name (already NFC-normalised + sanitised). */
    name: string;
    /** Spaces / R2 object key where the original archive lives. */
    path: string;
    /** Bytes. */
    size: number;
    /** Original upload filename (typically equal to `name`). */
    originalFilename?: string;
    /** Detected archive format (added in post-migration writes). */
    format?: SupportedArchiveExt | string;
    /** MIME type to set on outbound responses. */
    contentType?: string;
    /** Display extension including the leading dot (e.g. ".zip", ".tar.gz"). */
    extension?: string;
}

const SEVEN_ZIP_BIN = process.env.SEVEN_ZIP_PATH || '7z';
const isWindows = process.platform === 'win32';

/** Max chars of stdout/stderr to attach to error logs. */
const MAX_EXEC_LOG_CHUNK = 32768;

/** MIME map for archive formats (used when serving original archives). */
const ARCHIVE_MIME_MAP: Record<SupportedArchiveExt, string> = {
    zip: 'application/zip',
    rar: 'application/vnd.rar',
    '7z': 'application/x-7z-compressed',
    tar: 'application/x-tar',
    gz: 'application/gzip',
    tgz: 'application/gzip'
};

export function getArchiveMimeType(format: SupportedArchiveExt | string | null | undefined): string {
    if (!format) return 'application/octet-stream';
    const lower = String(format).toLowerCase();
    if (lower in ARCHIVE_MIME_MAP) {
        return ARCHIVE_MIME_MAP[lower as SupportedArchiveExt];
    }
    return 'application/octet-stream';
}

/**
 * Detect archive format from filename and/or magic bytes.
 * Magic bytes take precedence; extension is the fallback.
 */
export function detectArchiveFormat(filePathOrName: string, buffer?: Buffer): SupportedArchiveExt | null {
    if (buffer && buffer.length >= 8) {
        if (buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)) {
            return 'zip';
        }
        if (
            buffer[0] === 0x52 && buffer[1] === 0x61 && buffer[2] === 0x72 &&
            buffer[3] === 0x21 && buffer[4] === 0x1a && buffer[5] === 0x07
        ) {
            return 'rar';
        }
        if (
            buffer[0] === 0x37 && buffer[1] === 0x7a && buffer[2] === 0xbc &&
            buffer[3] === 0xaf && buffer[4] === 0x27 && buffer[5] === 0x1c
        ) {
            return '7z';
        }
        if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
            const lower = filePathOrName.toLowerCase();
            if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tgz';
            return 'gz';
        }
        if (buffer.length >= 262) {
            const ustar = buffer.subarray(257, 262).toString('ascii');
            if (ustar === 'ustar') return 'tar';
        }
    }

    const lower = filePathOrName.toLowerCase();
    if (lower.endsWith('.tar.gz')) return 'tgz';
    if (lower.endsWith('.tgz')) return 'tgz';
    if (lower.endsWith('.tar')) return 'tar';
    if (lower.endsWith('.gz')) return 'gz';
    if (lower.endsWith('.zip')) return 'zip';
    if (lower.endsWith('.rar')) return 'rar';
    if (lower.endsWith('.7z')) return '7z';
    return null;
}

/** Returns the original-style extension for a detected format (used for storage keys + content disposition). */
export function getArchiveExtension(format: SupportedArchiveExt): string {
    if (format === 'tgz') return '.tar.gz';
    return `.${format}`;
}

/**
 * Peeks magic bytes so we do not rely on `.zip` in the path alone (temp names keep extensions).
 *
 * `-mcu=on` is a **ZIP-only** `-m` sub-switch (UTF-8 entry names). 7-Zip treats unknown `-m`
 * parameters as fatal for other formats — `7z x foo.rar … -mcu=on` exits with code 2 even when
 * RAR support is installed. Only append it when the archive is actually ZIP.
 */
function extractFormatWithMagicPeek(archivePath: string): SupportedArchiveExt | null {
    const base = path.basename(archivePath);
    let peek: Buffer | undefined;
    try {
        const h = fs.openSync(archivePath, 'r');
        try {
            const buf = Buffer.alloc(64);
            const n = fs.readSync(h, buf, 0, 64, 0);
            peek = buf.subarray(0, n);
        } finally {
            fs.closeSync(h);
        }
    } catch {
        peek = undefined;
    }
    return detectArchiveFormat(base, peek);
}

function utf8ZipNameArgsForExtract(archivePath: string): string[] {
    return extractFormatWithMagicPeek(archivePath) === 'zip' ? ['-mcu=on'] : [];
}

interface RunSevenZOptions {
    cwd?: string;
    signal?: AbortSignal;
    /** Captured stdout buffer cap. Defaults to 16MiB. */
    maxStdoutBytes?: number;
    /** Stream stderr as it arrives (e.g. parse 7-Zip % progress). Full stderr is still captured for errors. */
    onStderrChunk?: (chunk: Buffer) => void;
    /** Stream stdout as it arrives (some 7-Zip builds emit progress there). Full stdout is still captured. */
    onStdoutChunk?: (chunk: Buffer) => void;
}

interface RunSevenZResult {
    stdout: string;
    stderr: string;
    code: number;
}

function trimForLog(s: string | undefined): string | undefined {
    if (!s) return undefined;
    const t = s.trimEnd();
    if (t.length <= MAX_EXEC_LOG_CHUNK) return t;
    return `${t.slice(0, MAX_EXEC_LOG_CHUNK)}… [truncated, total ${t.length} chars]`;
}

/**
 * What 7-Zip actually printed — used in {@link buildSevenZError} so logs show a
 * descriptive report instead of only `exit N`.
 *
 * Prefer stderr (errors/warnings); if stderr is empty, include stdout (some
 * builds still print fatal lines to stdout depending on `-bb*`).
 */
function formatSevenZFailureSummary(result: RunSevenZResult, maxLen = 6000): string {
    const errPart = (result.stderr ?? '').trim();
    const outPart = (result.stdout ?? '').trim();

    let combined: string;
    if (errPart && outPart) {
        combined = `stderr:\n${errPart}\n\nstdout:\n${outPart}`;
    } else if (errPart) {
        combined = errPart;
    } else if (outPart) {
        combined = `stdout:\n${outPart}`;
    } else {
        return '7z produced no stderr or stdout text (inspect permissions, disk full, missing binary, or wrong path).';
    }

    if (combined.length > maxLen) {
        return `${combined.slice(0, maxLen)}… [truncated, total ${combined.length} chars]`;
    }
    return combined;
}

/**
 * Spawn the 7z binary with the given arguments. Returns the captured streams
 * and exit code; only throws on spawn failure or AbortSignal trigger.
 *
 * Callers decide whether a non-zero exit code is fatal — list/extract treat
 * code 1 (warning) as soft success when output is present (matches the existing
 * pack-download behaviour).
 */
async function runSevenZ(args: string[], opts: RunSevenZOptions = {}): Promise<RunSevenZResult> {
    const { cwd, signal, maxStdoutBytes = 16 * 1024 * 1024, onStderrChunk, onStdoutChunk } = opts;

    return new Promise<RunSevenZResult>((resolve, reject) => {
        const env = isWindows
            ? process.env
            : { ...process.env, LC_ALL: 'C.UTF-8' };

        const child = spawn(SEVEN_ZIP_BIN, args, {
            cwd,
            env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let aborted = false;

        const onAbort = () => {
            aborted = true;
            try { child.kill('SIGTERM'); } catch { /* already exited */ }
        };
        if (signal) {
            if (signal.aborted) {
                onAbort();
            } else {
                signal.addEventListener('abort', onAbort, { once: true });
            }
        }

        child.stdout.on('data', (chunk: Buffer) => {
            onStdoutChunk?.(chunk);
            stdoutBytes += chunk.length;
            if (stdoutBytes <= maxStdoutBytes) stdoutChunks.push(chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => {
            onStderrChunk?.(chunk);
            stderrBytes += chunk.length;
            if (stderrBytes <= maxStdoutBytes) stderrChunks.push(chunk);
        });

        child.on('error', (err) => {
            if (signal) signal.removeEventListener('abort', onAbort);
            reject(err);
        });

        child.on('close', (code) => {
            if (signal) signal.removeEventListener('abort', onAbort);
            if (aborted) {
                const err = new Error('7z aborted by signal');
                (err as any).code = 'ABORT_ERR';
                return reject(err);
            }
            resolve({
                stdout: Buffer.concat(stdoutChunks).toString('utf8'),
                stderr: Buffer.concat(stderrChunks).toString('utf8'),
                code: code == null ? -1 : code
            });
        });
    });
}

/**
 * Known 7-Zip failure patterns that are caused by the uploaded archive itself
 * (corruption, truncation, encryption, unsupported method, ...) rather than
 * by our server. When matched, the error is tagged so upstream catch blocks
 * can demote logging from `error` to `info`/`warn` and forward a short,
 * user-actionable message to the client instead of the raw 7z transcript.
 */
interface UserArchiveErrorPattern {
    pattern: RegExp;
    /** Stable code used in API responses + structured logs. */
    kind: 'CORRUPT_ARCHIVE' | 'NOT_AN_ARCHIVE' | 'PASSWORD_PROTECTED' | 'UNSUPPORTED_METHOD' | 'EMPTY_ARCHIVE';
    /** Concise, end-user-facing message. */
    userMessage: string;
}

const USER_ARCHIVE_ERROR_PATTERNS: UserArchiveErrorPattern[] = [
    {
        pattern: /CRC Failed|Data Error(?! in encrypted)/i,
        kind: 'CORRUPT_ARCHIVE',
        userMessage:
            'Archive is corrupt or was incompletely uploaded (CRC check failed). ' +
            'Please re-export the archive from your file manager and upload it again.'
    },
    {
        pattern: /Headers Error|Unexpected end of (archive|data)|Unconfirmed start of archive/i,
        kind: 'CORRUPT_ARCHIVE',
        userMessage:
            'Archive is corrupt or truncated (header / end-of-archive error). ' +
            'Please re-export the archive and upload it again.'
    },
    {
        pattern: /Cannot open the file as \[?archive\]?|Cannot open encrypted archive\. Wrong password\?/i,
        kind: 'NOT_AN_ARCHIVE',
        userMessage:
            'File could not be opened as an archive. Please upload a valid .zip, .rar, .7z, .tar, .tar.gz, or .tgz file.'
    },
    {
        pattern: /Wrong password|Data Error in encrypted file\. Wrong password/i,
        kind: 'PASSWORD_PROTECTED',
        userMessage:
            'Archive is password-protected. Please upload an unencrypted archive.'
    },
    {
        pattern: /Unsupported Method|Unsupported compression method/i,
        kind: 'UNSUPPORTED_METHOD',
        userMessage:
            'Archive uses an unsupported compression method. Please re-export it with standard compression (Deflate, LZMA, LZMA2, or Store).'
    },
    {
        pattern: /No files to process|Can not open the file as archive: empty/i,
        kind: 'EMPTY_ARCHIVE',
        userMessage:
            'Archive is empty. Please upload an archive that contains a level (.adofai) and its audio file.'
    }
];

function detectUserArchiveError(summary: string): UserArchiveErrorPattern | null {
    for (const entry of USER_ARCHIVE_ERROR_PATTERNS) {
        if (entry.pattern.test(summary)) {
            return entry;
        }
    }
    return null;
}

/**
 * Augmented Error fields attached to 7z failures.
 *
 * `clientFacing === true` signals to upstream catch blocks that the failure was
 * caused by the user-supplied archive (corrupt / encrypted / wrong format), so
 * they should log it at info/warn level, omit the raw 7z transcript from logs,
 * and surface `userMessage` + `archiveErrorKind` to the client instead of the
 * full server-side error message.
 */
export interface SevenZErrorFields {
    exitCode: number;
    sevenZAction: string;
    sevenZBinary: string;
    args: string[];
    stdout?: string;
    stderr?: string;
    sevenZSummary: string;
    clientFacing?: boolean;
    archiveErrorKind?: UserArchiveErrorPattern['kind'];
    userMessage?: string;
}

function buildSevenZError(action: string, args: string[], result: RunSevenZResult): Error {
    const summary = formatSevenZFailureSummary(result);
    const binary = SEVEN_ZIP_BIN;
    const argsPreview =
        args.length > 12
            ? `${args.slice(0, 12).map((a) => (a.length > 120 ? `${a.slice(0, 120)}…` : a)).join(' ')} … (+${args.length - 12} args)`
            : args.map((a) => (a.length > 200 ? `${a.slice(0, 200)}…` : a)).join(' ');

    const userArchiveError = detectUserArchiveError(summary);

    const message = userArchiveError
        // Keep the canonical 7z transcript in `Error.message` for full debuggability —
        // catch blocks that opt into the demoted pipeline read `userMessage` instead.
        ? [
            `7z ${action} failed (exit ${result.code}) — ${userArchiveError.kind}.`,
            userArchiveError.userMessage,
            ``,
            summary
        ].join('\n')
        : [
            `7z ${action} failed (exit ${result.code}).`,
            `binary=${binary}`,
            `argv≈ ${argsPreview}`,
            ``,
            summary
        ].join('\n');

    const err = new Error(message);
    (err as any).exitCode = result.code;
    (err as any).sevenZAction = action;
    (err as any).sevenZBinary = binary;
    (err as any).args = args;
    (err as any).stdout = trimForLog(result.stdout);
    (err as any).stderr = trimForLog(result.stderr);
    /** Short duplicate of stderr/stdout for structured loggers without reading full stacks */
    (err as any).sevenZSummary = summary;
    if (userArchiveError) {
        (err as any).clientFacing = true;
        (err as any).archiveErrorKind = userArchiveError.kind;
        (err as any).userMessage = userArchiveError.userMessage;
    }
    return err;
}

/**
 * Validate that a file is a readable archive in any supported format.
 * Throws on failure.
 */
export async function validateArchive(filePath: string, signal?: AbortSignal): Promise<void> {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Archive not found: ${filePath}`);
    }
    const args = ['t', filePath, '-y', '-bd', '-bb0'];
    const result = await runSevenZ(args, { signal });
    if (result.code !== 0) {
        throw buildSevenZError('validate', args, result);
    }
}

/** Wraps validateArchive for buffer inputs (writes to a temp file, validates, unlinks). */
export async function validateArchiveBuffer(buffer: Buffer, hintFilename?: string, signal?: AbortSignal): Promise<void> {
    const detected = detectArchiveFormat(hintFilename || 'upload.bin', buffer);
    const ext = detected ? getArchiveExtension(detected) : '.bin';
    const tempPath = path.join(os.tmpdir(), `archive-validate-${crypto.randomUUID()}${ext}`);
    await fs.promises.writeFile(tempPath, buffer);
    try {
        await validateArchive(tempPath, signal);
    } finally {
        try { await fs.promises.unlink(tempPath); } catch { /* best effort */ }
    }
}

/**
 * Parse `7z l -slt -ba` machine output into ArchiveEntry records.
 *
 * Each entry is a block of `Key = Value` lines separated by a blank line.
 * Only `Path`, `Size`, and `Attributes`/`Folder` are required for our usage.
 */
function parseSlt(stdout: string): ArchiveEntry[] {
    const entries: ArchiveEntry[] = [];
    const blocks = stdout.split(/\r?\n\r?\n/);

    for (const block of blocks) {
        const trimmed = block.trim();
        if (!trimmed) continue;

        const fields: Record<string, string> = {};
        for (const line of trimmed.split(/\r?\n/)) {
            const eq = line.indexOf('=');
            if (eq <= 0) continue;
            const key = line.slice(0, eq).trim();
            const value = line.slice(eq + 1).trim();
            fields[key] = value;
        }

        const rawPath = fields['Path'];
        if (!rawPath) continue;
        // 7z's first record on .tar archives is sometimes a header — skip empty paths.
        if (rawPath === '') continue;

        const sizeStr = fields['Size'] ?? '0';
        const size = Number.parseInt(sizeStr, 10);
        const attributes = fields['Attributes'] ?? '';
        const folderField = fields['Folder'] ?? '';
        const isDirectory =
            folderField === '+' ||
            attributes.startsWith('D') ||
            attributes.includes('D ') ||
            rawPath.endsWith('/') || rawPath.endsWith('\\');

        const relativePath = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
        const name = path.posix.basename(relativePath);
        const sevenZipSelector = rawPath.replace(/^[/\\]+/, '');

        entries.push({
            name,
            relativePath,
            sevenZipSelector,
            size: Number.isFinite(size) ? size : 0,
            isDirectory
        });
    }

    return entries;
}

/**
 * List all entries in an archive (any supported format).
 */
export async function listEntries(filePath: string, signal?: AbortSignal): Promise<ArchiveEntry[]> {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Archive not found: ${filePath}`);
    }
    // Match UTF-8 ZIP name decoding with {@link extractAll} / {@link extractLevelPackPayload}
    // so `relativePath` aligns with on-disk paths after `-mcu=on` extraction.
    const args = ['l', '-slt', '-ba', '-y', filePath, ...utf8ZipNameArgsForExtract(filePath)];
    const result = await runSevenZ(args, { signal });
    // 7z exit codes: 0 = success, 1 = warnings (still usable), 2+ = fatal.
    if (result.code !== 0 && result.code !== 1) {
        throw buildSevenZError('list', args, result);
    }
    return parseSlt(result.stdout);
}

/**
 * Extract every entry from an archive to `destDir`. Creates the directory if missing.
 *
 * For **ZIP** only, we pass `-mcu=on` so UTF-8 paths inside the archive decode consistently.
 * That switch must not be used for RAR/7z/tar — 7-Zip exits fatally (code 2) if it is.
 */
export async function extractAll(archivePath: string, destDir: string, signal?: AbortSignal): Promise<void> {
    if (!fs.existsSync(archivePath)) {
        throw new Error(`Archive not found: ${archivePath}`);
    }
    await fs.promises.mkdir(destDir, { recursive: true });

    const args = ['x', archivePath, `-o${destDir}`, '-y', ...utf8ZipNameArgsForExtract(archivePath), '-bd', '-bb0'];
    const result = await runSevenZ(args, { signal });

    // Exit code 1 = warnings (e.g. filename encoding) but extraction usually succeeded.
    // Verify by checking destDir for any output.
    if (result.code !== 0 && result.code !== 1) {
        throw buildSevenZError('extract', args, result);
    }

    if (result.code === 1) {
        let entries: fs.Dirent[] = [];
        try {
            entries = await fs.promises.readdir(destDir, { withFileTypes: true });
        } catch { /* fall through */ }
        if (entries.length === 0) {
            throw buildSevenZError('extract (warning + empty output)', args, result);
        }
        logger.debug('archiveService.extractAll completed with warnings', {
            archivePath,
            destDir,
            stderr: trimForLog(result.stderr)
        });
    }
}

/**
 * 7-Zip `-i!` include filters for level-pack ingestion (`.adofai` + common audio).
 * Paired uppercase globs help on case-sensitive filesystems.
 */
const LEVEL_PACK_INCLUDE_GLOBS: string[] = [
    '-i!*.adofai',
    '-i!*.ADOFAI',
    '-i!*.mp3',
    '-i!*.MP3',
    '-i!*.wav',
    '-i!*.WAV',
    '-i!*.ogg',
    '-i!*.OGG',
    '-i!*.oga',
    '-i!*.OGA',
    '-i!*.opus',
    '-i!*.OPUS',
    '-i!*.flac',
    '-i!*.FLAC',
    '-i!*.m4a',
    '-i!*.M4A',
    '-i!*.aac',
    '-i!*.AAC',
    '-i!*.aiff',
    '-i!*.AIFF',
    '-i!*.aif',
    '-i!*.AIF',
    '-i!*.caf',
    '-i!*.CAF',
    '-i!*.wma',
    '-i!*.WMA',
    '-i!*.webm',
    '-i!*.WEBM',
    '-i!*.mka',
    '-i!*.MKA',
    '-i!*.ac3',
    '-i!*.AC3',
    '-i!*.eac3',
    '-i!*.EAC3',
    '-i!*.mp2',
    '-i!*.MP2',
    '-i!*.amr',
    '-i!*.AMR',
    '-i!*.ape',
    '-i!*.APE',
    '-i!*.wv',
    '-i!*.WV',
    '-i!*.tta',
    '-i!*.TTA'
];

/** True if `dir` contains at least one regular file somewhere beneath it. */
async function directoryHasAnyFile(dir: string): Promise<boolean> {
    const stack = [dir];
    while (stack.length > 0) {
        const d = stack.pop()!;
        let names: string[];
        try {
            names = await fs.promises.readdir(d);
        } catch {
            continue;
        }
        for (const n of names) {
            const p = path.join(d, n);
            try {
                const st = await fs.promises.stat(p);
                if (st.isFile()) return true;
                if (st.isDirectory()) stack.push(p);
            } catch {
                /* ignore */
            }
        }
    }
    return false;
}

/**
 * Extract only level + audio payloads into `extractRoot` (paths preserved).
 *
 * Uses one `7z x` with recursive include patterns, then falls back to {@link extractAll}
 * when filtered extraction fails (e.g. solid RAR5 + selective quirks) or yields no files.
 * Downstream code still uses {@link listEntries} for canonical archive-relative paths.
 *
 * @param options.requiredRelativePaths — When set, a filtered extract is only accepted if
 * every listed path exists under `extractRoot`. Otherwise we fall back to {@link extractAll}
 * (fixes partial filtered extracts where 7-Zip wrote some globs but skipped nested files).
 */
export async function extractLevelPackPayload(
    archivePath: string,
    extractRoot: string,
    signal?: AbortSignal,
    options?: { requiredRelativePaths?: string[] }
): Promise<void> {
    if (!fs.existsSync(archivePath)) {
        throw new Error(`Archive not found: ${archivePath}`);
    }
    await fs.promises.mkdir(extractRoot, { recursive: true });

    const filteredArgs = [
        'x',
        archivePath,
        `-o${extractRoot}`,
        '-y',
        '-r',
        ...LEVEL_PACK_INCLUDE_GLOBS,
        ...utf8ZipNameArgsForExtract(archivePath),
        '-bd',
        '-bb0'
    ];

    const result = await runSevenZ(filteredArgs, { signal });

    const filteredOk = result.code === 0 || result.code === 1;
    const hasFiles = filteredOk ? await directoryHasAnyFile(extractRoot) : false;

    let missingRequired: string[] = [];
    if (filteredOk && hasFiles && options?.requiredRelativePaths?.length) {
        missingRequired = options.requiredRelativePaths.filter(rel => {
            const normalized = rel.replace(/\\/g, '/').replace(/^\/+/, '');
            return !fs.existsSync(path.join(extractRoot, normalized));
        });
        if (missingRequired.length > 0) {
            logger.debug('archiveService.extractLevelPackPayload: filtered extract missing required paths; falling back to extractAll', {
                archivePath,
                missingCount: missingRequired.length,
                missingSample: missingRequired.slice(0, 8)
            });
        }
    }

    const needFullExtract = !filteredOk || !hasFiles || missingRequired.length > 0;

    if (!needFullExtract) {
        if (result.code === 1) {
            logger.debug('archiveService.extractLevelPackPayload: filtered extract completed with warnings', {
                archivePath,
                extractRoot,
                stderr: trimForLog(result.stderr)
            });
        }
        return;
    }

    if (!filteredOk) {
        logger.debug('archiveService.extractLevelPackPayload: filtered extract failed; falling back to extractAll', {
            archivePath,
            exitCode: result.code,
            stderr: trimForLog(result.stderr)
        });
    } else {
        logger.debug('archiveService.extractLevelPackPayload: filtered extract produced no files; falling back to extractAll', {
            archivePath,
            extractRoot
        });
    }

    await fs.promises.rm(extractRoot, { recursive: true, force: true });
    await fs.promises.mkdir(extractRoot, { recursive: true });
    await extractAll(archivePath, extractRoot, signal);
}

/**
 * Extract a single entry from an archive to a precise output file path.
 *
 * 7z's `e` flattens to a directory; we extract into a temp folder, locate the
 * extracted file, and rename it to `destFilePath`.
 *
 * `-bd` — batch / hide `%` progress; does not change exit codes or extraction behaviour.
 * `-bb0` — quiet listing on stdout; fatal errors still appear on stderr.
 */
export async function extractEntry(
    archivePath: string,
    entry: Pick<ArchiveEntry, 'relativePath' | 'sevenZipSelector'>,
    destFilePath: string,
    signal?: AbortSignal
): Promise<void> {
    if (!fs.existsSync(archivePath)) {
        throw new Error(`Archive not found: ${archivePath}`);
    }

    await fs.promises.mkdir(path.dirname(destFilePath), { recursive: true });

    // Stage extraction inside a unique temp folder so we can safely rename
    // even when the entry's basename conflicts with sibling files.
    const stagingDir = path.join(
        path.dirname(destFilePath),
        `.extract-${crypto.randomUUID()}`
    );
    await fs.promises.mkdir(stagingDir, { recursive: true });

    try {
        const pathFor7z = entry.sevenZipSelector || entry.relativePath;

        // `x` (preserve paths) inside a private staging folder gives us deterministic
        // resolution even when entries share a basename with other paths in the archive.
        const args = [
            'x', archivePath, pathFor7z, `-o${stagingDir}`, '-y',
            ...utf8ZipNameArgsForExtract(archivePath),
            '-bd', '-bb0'
        ];
        const result = await runSevenZ(args, { signal });

        if (result.code !== 0 && result.code !== 1) {
            throw buildSevenZError('extract entry', args, result);
        }

        const normalized = entry.relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
        const stagedPath = path.join(stagingDir, normalized);

        if (!fs.existsSync(stagedPath)) {
            throw new Error(
                `Entry not found after extraction: ${entry.relativePath} (staged at ${stagedPath})`
            );
        }

        // Replace destFilePath atomically.
        try {
            await fs.promises.rm(destFilePath, { force: true });
        } catch { /* best effort */ }
        await fs.promises.rename(stagedPath, destFilePath).catch(async (err) => {
            // Cross-device rename can fail with EXDEV — fall back to copy + unlink.
            if ((err as NodeJS.ErrnoException)?.code === 'EXDEV') {
                await fs.promises.copyFile(stagedPath, destFilePath);
                await fs.promises.unlink(stagedPath);
                return;
            }
            throw err;
        });
    } finally {
        try {
            await fs.promises.rm(stagingDir, { recursive: true, force: true });
        } catch (err) {
            logger.debug('archiveService.extractEntry: failed to cleanup staging dir', {
                stagingDir,
                error: err instanceof Error ? err.message : String(err)
            });
        }
    }
}

/** Optional settings for {@link createZip}. */
export interface CreateZipOptions {
    signal?: AbortSignal;
    /** Best-effort 0–100 from 7-Zip stderr (`%` tokens); may not fire on all versions/locales. */
    onZipProgress?: (percent: number) => void;
}

const ZIP_PROGRESS_STREAM_WINDOW = 16_000;

/**
 * Feeds combined stdout/stderr from `7z` into a rolling buffer and reports the latest `%` value.
 * Some builds/locales omit `\b` boundaries or print `50 %` with a space; progress may appear on stdout.
 */
function createSevenZipPercentFeed(onZipProgress: (percent: number) => void): {
    push: (chunk: Buffer) => void;
    getSawProgress: () => boolean;
} {
    let carry = '';
    let sawProgress = false;
    const re = /(\d{1,3})\s*%/g;
    const push = (chunk: Buffer) => {
        carry = (carry + chunk.toString('utf8')).slice(-ZIP_PROGRESS_STREAM_WINDOW);
        let best = -1;
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(carry)) !== null) {
            const v = Math.min(100, Math.max(0, parseInt(m[1], 10)));
            if (v > best) best = v;
        }
        if (best >= 0) {
            sawProgress = true;
            onZipProgress(best);
        }
    };
    return { push, getSawProgress: () => sawProgress };
}

/**
 * Recursively zip everything inside `sourceDir` into `targetZipPath`.
 *
 * Output is always a `.zip` (Store / no compression) so downstream consumers
 * — game clients, browsers, the existing transform-download flow — keep working
 * unchanged.
 *
 * When `onZipProgress` is set, stderr is parsed for `%` progress (7-Zip without `-bd`).
 */
export async function createZip(
    sourceDir: string,
    targetZipPath: string,
    options?: CreateZipOptions
): Promise<void> {
    if (!fs.existsSync(sourceDir)) {
        throw new Error(`Source directory not found: ${sourceDir}`);
    }
    await fs.promises.mkdir(path.dirname(targetZipPath), { recursive: true });
    // Pre-delete: 7z `a` appends to existing archives, which would silently corrupt repeats.
    try { await fs.promises.rm(targetZipPath, { force: true }); } catch { /* best effort */ }

    const onZipProgress = options?.onZipProgress;
    const args = [
        'a', '-tzip',
        '-mx=0', '-mm=Copy',
        '-mcu=on', '-r',
        // Omit `-bd` so 7-Zip can emit `%` progress; `-bb1` lists added files (helps some builds emit usable output).
        '-y', '-bb1',
        targetZipPath,
        '*'
    ];
    const progressFeed = onZipProgress ? createSevenZipPercentFeed(onZipProgress) : null;
    const result = await runSevenZ(args, {
        cwd: sourceDir,
        signal: options?.signal,
        onStderrChunk: progressFeed ? progressFeed.push : undefined,
        onStdoutChunk: progressFeed ? progressFeed.push : undefined
    });
    if (progressFeed && !progressFeed.getSawProgress()) {
        logger.debug(
            'archiveService.createZip: no 7-Zip % lines parsed for progress (JOB_PROGRESS_INGEST / UI may stay at 0 until upload). Check: `SEVEN_ZIP_PATH`, run the same argv locally, non-English 7z UI, or `-bb`/`-bsp` behavior for your 7-Zip version.',
            {
                sevenZipBinary: SEVEN_ZIP_BIN,
                stderrTail: trimForLog(result.stderr?.slice(-2500)),
                stdoutTail: trimForLog(result.stdout?.slice(-2500)),
                exitCode: result.code
            }
        );
    }
    if (result.code !== 0 && result.code !== 1) {
        throw buildSevenZError('createZip', args, result);
    }
}

/**
 * Build a `.zip` from an explicit list of source files, each with the path it
 * should appear under inside the archive. Used by the level-repack flow that
 * needs to merge a single .adofai + song into a flat zip.
 *
 * Implementation strategy: stage all files into a temp directory using the
 * desired in-archive names, then run a single `createZip` over that staging dir.
 * This is simpler and more reliable than juggling 7z's per-file `-i` filters.
 */
/**
 * Resolve the original-archive descriptor from a `CdnFile.metadata` blob, normalising
 * across pre-migration (`originalZip` only, format-less) and post-migration
 * (`originalArchive` with format/contentType/extension) writes.
 *
 * Returns `null` if neither field is present or the underlying object is malformed.
 * Always derives a `format` + `contentType` + `extension` so downstream code can rely
 * on them being set.
 */
export function getOriginalArchiveMeta(metadata: unknown): OriginalArchiveMeta | null {
    if (!metadata || typeof metadata !== 'object') return null;

    const meta = metadata as Record<string, unknown>;
    const raw = (meta.originalArchive ?? meta.originalZip) as Partial<OriginalArchiveMeta> | undefined;
    if (!raw || typeof raw !== 'object') return null;

    if (typeof raw.path !== 'string' || typeof raw.name !== 'string') return null;

    // Heal pre-fix rows whose `name` / `originalFilename` were written with
    // busboy's latin-1 mojibake. `decodeMultipartFilename` is a no-op on
    // already-correct UTF-8 (see multipartFilename.ts), so this is safe to
    // apply unconditionally on read.
    const healedName = decodeMultipartFilename(raw.name);
    const healedOriginalFilename = raw.originalFilename
        ? decodeMultipartFilename(raw.originalFilename)
        : healedName;

    const fileNameForDetection = healedOriginalFilename || healedName;
    const detected = (raw.format && typeof raw.format === 'string'
        ? (raw.format as SupportedArchiveExt)
        : detectArchiveFormat(fileNameForDetection) || 'zip');

    const extension = raw.extension || getArchiveExtension(detected as SupportedArchiveExt);
    const contentType = raw.contentType || getArchiveMimeType(detected);

    return {
        name: healedName,
        path: raw.path,
        size: typeof raw.size === 'number' ? raw.size : 0,
        originalFilename: healedOriginalFilename,
        format: detected,
        contentType,
        extension
    };
}

export async function createZipFromFiles(
    files: { path: string; nameInArchive: string }[],
    targetZipPath: string,
    signal?: AbortSignal
): Promise<void> {
    if (files.length === 0) {
        throw new Error('createZipFromFiles requires at least one file');
    }

    const stagingDir = path.join(
        path.dirname(targetZipPath),
        `.zipstage-${crypto.randomUUID()}`
    );
    await fs.promises.mkdir(stagingDir, { recursive: true });

    try {
        for (const file of files) {
            const inArchive = file.nameInArchive.replace(/\\/g, '/').replace(/^\/+/, '');
            if (!inArchive) {
                throw new Error(`Empty nameInArchive for source ${file.path}`);
            }
            const stagedPath = path.join(stagingDir, inArchive);
            await fs.promises.mkdir(path.dirname(stagedPath), { recursive: true });
            await fs.promises.copyFile(file.path, stagedPath);
        }

        await createZip(stagingDir, targetZipPath, { signal });
    } finally {
        try {
            await fs.promises.rm(stagingDir, { recursive: true, force: true });
        } catch (err) {
            logger.debug('archiveService.createZipFromFiles: failed to cleanup staging dir', {
                stagingDir,
                error: err instanceof Error ? err.message : String(err)
            });
        }
    }
}
