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
 * Spawn the 7z binary with the given arguments. Returns the captured streams
 * and exit code; only throws on spawn failure or AbortSignal trigger.
 *
 * Callers decide whether a non-zero exit code is fatal — list/extract treat
 * code 1 (warning) as soft success when output is present (matches the existing
 * pack-download behaviour).
 */
async function runSevenZ(args: string[], opts: RunSevenZOptions = {}): Promise<RunSevenZResult> {
    const { cwd, signal, maxStdoutBytes = 16 * 1024 * 1024 } = opts;

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
            stdoutBytes += chunk.length;
            if (stdoutBytes <= maxStdoutBytes) stdoutChunks.push(chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => {
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

function buildSevenZError(action: string, args: string[], result: RunSevenZResult): Error {
    const err = new Error(`7z ${action} failed (exit ${result.code})`);
    (err as any).exitCode = result.code;
    (err as any).args = args;
    (err as any).stdout = trimForLog(result.stdout);
    (err as any).stderr = trimForLog(result.stderr);
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

        entries.push({
            name,
            relativePath,
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
    const args = ['l', '-slt', '-ba', '-y', filePath];
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
 * Extract a single entry from an archive to a precise output file path.
 *
 * 7z's `e` flattens to a directory; we extract into a temp folder, locate the
 * extracted file, and rename it to `destFilePath`.
 */
export async function extractEntry(
    archivePath: string,
    entryRelativePath: string,
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
        // `x` (preserve paths) inside a private staging folder gives us deterministic
        // resolution even when entries share a basename with other paths in the archive.
        const args = [
            'x', archivePath, entryRelativePath, `-o${stagingDir}`, '-y',
            ...utf8ZipNameArgsForExtract(archivePath),
            '-bd', '-bb0'
        ];
        const result = await runSevenZ(args, { signal });

        if (result.code !== 0 && result.code !== 1) {
            throw buildSevenZError('extract entry', args, result);
        }

        const normalized = entryRelativePath.replace(/\\/g, '/').replace(/^\/+/, '');
        const stagedPath = path.join(stagingDir, normalized);

        if (!fs.existsSync(stagedPath)) {
            throw new Error(
                `Entry not found after extraction: ${entryRelativePath} (staged at ${stagedPath})`
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

/**
 * Recursively zip everything inside `sourceDir` into `targetZipPath`.
 *
 * Output is always a `.zip` (Store / no compression) so downstream consumers
 * — game clients, browsers, the existing transform-download flow — keep working
 * unchanged.
 */
export async function createZip(sourceDir: string, targetZipPath: string, signal?: AbortSignal): Promise<void> {
    if (!fs.existsSync(sourceDir)) {
        throw new Error(`Source directory not found: ${sourceDir}`);
    }
    await fs.promises.mkdir(path.dirname(targetZipPath), { recursive: true });
    // Pre-delete: 7z `a` appends to existing archives, which would silently corrupt repeats.
    try { await fs.promises.rm(targetZipPath, { force: true }); } catch { /* best effort */ }

    const args = [
        'a', '-tzip',
        '-mx=0', '-mm=Copy',
        '-mcu=on', '-r',
        '-y', '-bd', '-bb0',
        targetZipPath,
        '*'
    ];
    const result = await runSevenZ(args, { cwd: sourceDir, signal });
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

        await createZip(stagingDir, targetZipPath, signal);
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
