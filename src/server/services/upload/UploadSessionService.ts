import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Request } from 'express';
import type { Transaction } from 'sequelize';
import { Op } from 'sequelize';

import { getSequelizeForModelGroup } from '@/config/db.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { safeRemoveUnderRoot } from '@/misc/utils/fs/fsSafeRemove.js';
import { writeFileAtomic, writeStreamAtomic } from '@/misc/utils/fs/fsSafeWrite.js';
import {
  WORKSPACE_ROOT,
  type WorkspaceDomain,
} from '@/server/services/core/WorkspaceService.js';
import {
  getGlobalAbortSignal,
  registerShutdownStep,
} from '@/server/bootstrap/shutdownCoordinator.js';
import UploadSession, {
  type UploadSessionAttributes,
  type UploadSessionStatus,
} from '@/models/upload/UploadSession.js';

/**
 * Per-kind configuration for chunked uploads.
 *
 * Upload kinds describe what the server should do with the assembled file. The
 * router owns the transport (init/chunk/complete/cancel/status) and delegates
 * authorisation + finalisation to the kind implementation.
 */
export interface UploadKind<Meta = Record<string, unknown>, Result = Record<string, unknown>> {
  /** Stable identifier, e.g. `'level-zip'`. Persisted on the row. */
  readonly id: string;
  /** Workspace domain bucket used for per-session dirs. */
  readonly workspaceDomain: WorkspaceDomain;
  /** Max assembled file size in bytes. Enforced at `/init`. */
  readonly maxFileSize: number;
  /** Allowed chunk size range (inclusive). */
  readonly chunkSize: { min: number; max: number };
  /** Session TTL in ms after last activity. Default 24h. */
  readonly sessionTtlMs?: number;
  /** Optional mime type allow-list; if present, `mimeType` must match. */
  readonly allowedMimeTypes?: readonly string[];

  /**
   * Validate the init payload and authorise the caller.
   *
   * Throw an {@link UploadError} to bail out with a specific status code / message.
   * Return an object with the validated, server-trusted `meta` object that will
   * be persisted on the session.
   */
  validateInit(args: {
    req: Request;
    userId: string;
    originalName: string;
    mimeType: string | null;
    declaredSize: number;
    declaredHash: string;
    meta: unknown;
  }): Promise<{ meta: Meta }>;

  /**
   * Run kind-specific finalisation once the assembled file + verified hash are ready.
   * The assembled file lives at `assembledPath`; the kind may move it elsewhere,
   * record DB rows, etc. Return value is persisted on the row and echoed back
   * from `/complete` (including idempotent re-calls).
   */
  onAssembled(args: {
    session: UploadSession;
    assembledPath: string;
    assembledHash: string;
    originalName: string;
    meta: Meta;
    signal: AbortSignal;
  }): Promise<Result>;

  /** Optional hook called when a session is cancelled or expires. */
  onCancelled?(session: UploadSession): Promise<void>;
}

/** Thrown from kind hooks to return a specific HTTP status to the caller. */
export class UploadError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'UploadError';
  }
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

const uploadsSequelize = getSequelizeForModelGroup('uploads');

const kindRegistry = new Map<string, UploadKind<any, any>>();

export function registerUploadKind<M, R>(kind: UploadKind<M, R>): void {
  if (kindRegistry.has(kind.id)) {
    throw new Error(`Upload kind already registered: ${kind.id}`);
  }
  kindRegistry.set(kind.id, kind);
}

export function getUploadKind(id: string): UploadKind | null {
  return kindRegistry.get(id) ?? null;
}

/** Strictly confine every on-disk op to the session's own workspace dir. */
function joinUnder(baseDir: string, ...parts: string[]): string {
  const target = path.resolve(baseDir, ...parts);
  const baseAbs = path.resolve(baseDir);
  const baseWithSep = baseAbs.endsWith(path.sep) ? baseAbs : baseAbs + path.sep;
  if (target !== baseAbs && !target.startsWith(baseWithSep)) {
    throw new Error(`Upload session path traversal refused: ${parts.join('/')}`);
  }
  return target;
}

function sessionWorkspaceDir(kind: UploadKind, sessionId: string): string {
  return path.join(WORKSPACE_ROOT, kind.workspaceDomain, 'sessions', sessionId);
}

function chunksDir(workspaceDir: string): string {
  return joinUnder(workspaceDir, 'chunks');
}

function chunkPath(workspaceDir: string, index: number): string {
  return joinUnder(workspaceDir, 'chunks', `c_${index.toString().padStart(8, '0')}`);
}

function assembledPath(workspaceDir: string): string {
  return joinUnder(workspaceDir, 'assembled.bin');
}

/** NFC-normalise the user-supplied file name. Strip control chars + trim length. */
function normaliseOriginalName(raw: string): string {
  const nfc = raw.normalize('NFC');
  const noControls = nfc.replace(/[\u0000-\u001F\u007F]/g, '');
  if (noControls.length === 0) return 'file';
  if (noControls.length > 400) return noControls.slice(0, 400);
  return noControls;
}

function isHexSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

/** Build touch timestamps for TTL extension. */
function buildExpiresAt(kind: UploadKind): Date {
  const ttl = kind.sessionTtlMs ?? DEFAULT_TTL_MS;
  return new Date(Date.now() + ttl);
}

export interface CreateSessionArgs {
  req: Request;
  kindId: string;
  originalName: string;
  mimeType?: string | null;
  declaredSize: number;
  declaredHash: string;
  chunkSize: number;
  meta?: unknown;
}

export interface CreateSessionResult {
  session: UploadSession;
  kind: UploadKind;
  totalChunks: number;
  resumed: boolean;
}

/**
 * Create (or resume) an upload session. If a non-terminal session exists for the
 * same user + kind + declaredHash + declaredSize, it is returned as-is so the
 * client can resume without re-uploading already-received chunks.
 */
export async function createOrResumeSession(args: CreateSessionArgs): Promise<CreateSessionResult> {
  const { req, kindId, declaredSize, declaredHash, chunkSize } = args;
  const kind = getUploadKind(kindId);
  if (!kind) throw new UploadError(400, `Unknown upload kind: ${kindId}`);

  const userId = req.user?.id;
  if (!userId) throw new UploadError(401, 'Authentication required');

  if (!Number.isFinite(declaredSize) || declaredSize <= 0) {
    throw new UploadError(400, 'Invalid declared file size');
  }
  if (declaredSize > kind.maxFileSize) {
    throw new UploadError(413, `File exceeds max size for kind ${kindId}`);
  }
  if (!isHexSha256(declaredHash)) {
    throw new UploadError(400, 'declaredHash must be a hex-encoded SHA-256 digest');
  }
  if (!Number.isFinite(chunkSize) || chunkSize < kind.chunkSize.min || chunkSize > kind.chunkSize.max) {
    throw new UploadError(400, `chunkSize must be between ${kind.chunkSize.min} and ${kind.chunkSize.max}`);
  }
  const mimeType = args.mimeType ? args.mimeType.trim().toLowerCase() : null;
  if (kind.allowedMimeTypes && mimeType && !kind.allowedMimeTypes.includes(mimeType)) {
    throw new UploadError(415, `mimeType ${mimeType} not allowed for kind ${kindId}`);
  }
  const originalName = normaliseOriginalName(args.originalName);
  const totalChunks = Math.ceil(declaredSize / chunkSize);
  if (!Number.isFinite(totalChunks) || totalChunks <= 0) {
    throw new UploadError(400, 'Invalid totalChunks');
  }

  const { meta } = await kind.validateInit({
    req,
    userId,
    originalName,
    mimeType,
    declaredSize,
    declaredHash,
    meta: args.meta,
  });

  const existing = await UploadSession.findOne({
    where: {
      kind: kind.id,
      userId,
      declaredHash: declaredHash.toLowerCase(),
      declaredSize,
      status: { [Op.in]: ['uploading', 'assembling', 'assembled'] as UploadSessionStatus[] },
    },
  });
  if (existing) {
    const now = new Date();
    if (existing.expiresAt.getTime() < now.getTime()) {
      // Stale — nuke and fall through to create a fresh one.
      await destroySession(existing);
    } else {
      existing.expiresAt = buildExpiresAt(kind);
      existing.meta = meta as Record<string, unknown>;
      await existing.save();
      return {
        session: existing,
        kind,
        totalChunks: existing.totalChunks,
        resumed: true,
      };
    }
  }

  const id = crypto.randomUUID();
  const workspaceDir = sessionWorkspaceDir(kind, id);
  await fs.promises.mkdir(chunksDir(workspaceDir), { recursive: true });

  const session = await UploadSession.create({
    id,
    kind: kind.id,
    userId,
    originalName,
    mimeType,
    declaredSize,
    declaredHash: declaredHash.toLowerCase(),
    chunkSize,
    totalChunks,
    receivedChunks: [],
    status: 'uploading',
    assembledPath: null,
    assembledHash: null,
    result: null,
    meta: meta as Record<string, unknown>,
    workspaceDir,
    errorMessage: null,
    expiresAt: buildExpiresAt(kind),
  });

  logger.debug(`Upload session created ${session.id} (kind=${kind.id}, chunks=${totalChunks})`);
  return { session, kind, totalChunks, resumed: false };
}

/** Look up a session owned by the caller; 404/403 on miss. */
export async function getOwnedSession(sessionId: string, userId: string): Promise<UploadSession> {
  const session = await UploadSession.findByPk(sessionId);
  if (!session) throw new UploadError(404, 'Upload session not found');
  if (session.userId !== userId) throw new UploadError(403, 'Forbidden');
  return session;
}

/**
 * Persist a chunk for a session. Idempotent: writing the same index twice is a no-op.
 *
 * Concurrency: the client uploads chunks in parallel, so N handlers race on the same
 * row's `receivedChunks` JSON column. A naive read-modify-write on the in-memory
 * Sequelize instance causes lost updates (handler B loads the pre-A state, appends
 * its index, and overwrites A's write). We serialise the index-list update with a
 * transactional `SELECT ... FOR UPDATE` on the session row. The chunk *file* write
 * stays outside the transaction so concurrent PUTs still hit disk in parallel.
 */
export async function writeChunk(args: {
  session: UploadSession;
  index: number;
  data: Buffer;
}): Promise<UploadSession> {
  const { session, index, data } = args;
  if (session.status !== 'uploading') {
    throw new UploadError(409, `Cannot accept chunks in status ${session.status}`);
  }
  if (!Number.isInteger(index) || index < 0 || index >= session.totalChunks) {
    throw new UploadError(400, 'Chunk index out of range');
  }
  const expectedSize = index === session.totalChunks - 1
    ? session.declaredSize - index * session.chunkSize
    : session.chunkSize;
  if (data.length !== expectedSize) {
    throw new UploadError(400, `Chunk size mismatch (expected ${expectedSize}, got ${data.length})`);
  }

  await writeFileAtomic(chunkPath(session.workspaceDir, index), data);

  const kind = getUploadKind(session.kind);
  if (!kind) throw new UploadError(500, `Kind ${session.kind} no longer registered`);

  return uploadsSequelize.transaction(async (t) => {
    const locked = await UploadSession.findByPk(session.id, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!locked) throw new UploadError(404, 'Upload session not found');
    if (locked.status !== 'uploading') {
      throw new UploadError(409, `Cannot accept chunks in status ${locked.status}`);
    }
    if (!locked.receivedChunks.includes(index)) {
      locked.receivedChunks = [...locked.receivedChunks, index].sort((a, b) => a - b);
      locked.changed('receivedChunks', true);
    }
    locked.expiresAt = buildExpiresAt(kind);
    await locked.save({ transaction: t });
    return locked;
  });
}

/**
 * Streaming assembly: concat chunks through a sha256 hasher into a single file,
 * verify against declaredHash, and invoke the kind's `onAssembled` hook. The
 * assembled file is left on disk inside the session workspace until the session
 * is either replaced, cancelled, or expires.
 */
export async function completeSession(session: UploadSession): Promise<UploadSession> {
  if (session.status === 'assembled') {
    // Idempotent re-complete.
    return session;
  }
  if (session.status !== 'uploading') {
    throw new UploadError(409, `Cannot complete in status ${session.status}`);
  }
  const kind = getUploadKind(session.kind);
  if (!kind) throw new UploadError(500, `Kind ${session.kind} no longer registered`);

  const received = new Set(session.receivedChunks);
  for (let i = 0; i < session.totalChunks; i++) {
    if (!received.has(i)) throw new UploadError(409, `Missing chunk ${i}`);
  }

  session.status = 'assembling';
  await session.save();

  const target = assembledPath(session.workspaceDir);
  const tmp = `${target}.partial`;
  const signal = getGlobalAbortSignal();
  const hasher = crypto.createHash('sha256');

  let bytesWritten = 0;
  try {
    await fs.promises.rm(target, { force: true });
    await fs.promises.rm(tmp, { force: true });
    const out = fs.createWriteStream(tmp);
    try {
      for (let i = 0; i < session.totalChunks; i++) {
        if (signal.aborted) throw new Error('shutdown');
        const chunkBuf = await fs.promises.readFile(chunkPath(session.workspaceDir, i));
        hasher.update(chunkBuf);
        bytesWritten += chunkBuf.length;
        if (!out.write(chunkBuf)) {
          await new Promise<void>((resolve, reject) => {
            const onDrain = () => { cleanup(); resolve(); };
            const onError = (err: Error) => { cleanup(); reject(err); };
            const cleanup = () => {
              out.off('drain', onDrain);
              out.off('error', onError);
            };
            out.once('drain', onDrain);
            out.once('error', onError);
          });
        }
      }
      await new Promise<void>((resolve, reject) => {
        out.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
    } catch (err) {
      out.destroy();
      throw err;
    }

    if (bytesWritten !== session.declaredSize) {
      throw new UploadError(409, `Assembled size mismatch (expected ${session.declaredSize}, got ${bytesWritten})`);
    }
    const computed = hasher.digest('hex');
    if (computed.toLowerCase() !== session.declaredHash.toLowerCase()) {
      throw new UploadError(409, `SHA-256 mismatch: expected ${session.declaredHash}, got ${computed}`);
    }

    // Atomic move into final name.
    await fs.promises.rename(tmp, target);

    session.assembledPath = target;
    session.assembledHash = computed;
    await session.save();

    // Drop raw chunks now that we have the assembled file.
    await safeRemoveUnderRoot(chunksDir(session.workspaceDir), WORKSPACE_ROOT).catch(err => {
      logger.warn(`Failed to drop chunks for session ${session.id}:`, err);
    });

    const result = await kind.onAssembled({
      session,
      assembledPath: target,
      assembledHash: computed,
      originalName: session.originalName,
      meta: (session.meta ?? {}) as Record<string, unknown>,
      signal,
    });

    session.status = 'assembled';
    session.result = (result ?? null) as Record<string, unknown> | null;
    session.errorMessage = null;
    session.expiresAt = buildExpiresAt(kind);
    await session.save();
    return session;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    session.status = 'failed';
    session.errorMessage = msg.slice(0, 2000);
    await session.save().catch(() => {});
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Cancel: mark cancelled, delete row (hook wipes disk). Idempotent. */
export async function cancelSession(session: UploadSession): Promise<void> {
  if (session.status === 'cancelled') return;
  const kind = getUploadKind(session.kind);
  try {
    if (kind?.onCancelled) await kind.onCancelled(session);
  } catch (err) {
    logger.warn(`Upload kind ${session.kind} onCancelled hook failed:`, err);
  }
  await destroySession(session);
}

/** Raw row+disk delete. Prefer {@link cancelSession} externally. */
export async function destroySession(session: UploadSession, transaction?: Transaction): Promise<void> {
  await session.destroy({ transaction });
}

/**
 * Reaper: delete rows past `expiresAt`. The `beforeDestroy` hook wipes workspace dirs.
 * Lightweight — runs at boot and via shutdown ordering. A scheduled interval reruns hourly.
 */
export async function reapExpiredSessions(): Promise<number> {
  const now = new Date();
  const stale = await UploadSession.findAll({
    where: { expiresAt: { [Op.lt]: now } },
    limit: 500,
  });
  let count = 0;
  for (const row of stale) {
    try {
      await row.destroy();
      count++;
    } catch (err) {
      logger.warn(`Failed to reap upload session ${row.id}:`, err);
    }
  }
  return count;
}

let reaperHandle: NodeJS.Timeout | null = null;
/** Start the periodic reaper and register shutdown cleanup. Idempotent. */
export function startUploadSessionReaper(): void {
  if (reaperHandle) return;
  reaperHandle = setInterval(() => {
    reapExpiredSessions().catch(err => logger.warn('Upload session reaper failed:', err));
  }, 60 * 60 * 1000);
  reaperHandle.unref?.();
  registerShutdownStep({
    name: 'upload-session-reaper',
    priority: 30,
    fn: async () => {
      if (reaperHandle) {
        clearInterval(reaperHandle);
        reaperHandle = null;
      }
    },
  });
}

/** Used by the router to compute missing chunk set for status + resume. */
export function getMissingChunks(session: UploadSession): number[] {
  const received = new Set(session.receivedChunks);
  const missing: number[] = [];
  for (let i = 0; i < session.totalChunks; i++) {
    if (!received.has(i)) missing.push(i);
  }
  return missing;
}

export type { UploadSession, UploadSessionAttributes };

/** For kinds that want to produce a stable, safe on-disk filename from the original one. */
export function safeDiskFilename(originalName: string, fallbackExt?: string): string {
  const base = normaliseOriginalName(originalName);
  const cleaned = base
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length > 0) return cleaned;
  return fallbackExt ? `file${fallbackExt}` : 'file';
}

export { writeFileAtomic, writeStreamAtomic };
