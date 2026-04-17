import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { CDN_CONFIG } from '@/externalServices/cdnService/config.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { safeRemoveUnderRoot } from '@/misc/utils/fs/fsSafeRemove.js';
import { writeFileAtomic, writeStreamAtomic } from '@/misc/utils/fs/fsSafeWrite.js';
import {
  getGlobalAbortSignal,
  registerShutdownStep,
} from '@/server/bootstrap/shutdownCoordinator.js';
import { Readable } from 'stream';

/**
 * All worksite roots live under WORKSPACE_ROOT.
 * Defaults to `<CDN_CONFIG.localRoot>/tuf-workspaces` so the workspace tree shares a volume
 * with everything else under CDN_TEMP_ROOT (atomic rename across same volume).
 */
export const WORKSPACE_ROOT: string = (() => {
  const fromEnv = process.env.WORKSPACE_ROOT?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(CDN_CONFIG.localRoot, 'tuf-workspaces');
})();

export type WorkspaceDomain =
  | 'chunked-upload'
  | 'pack-download'
  | 'translation-verify'
  | 'translation-download'
  | 'form-upload'
  | 'level-cache'
  | 'levels-route-modes'
  | 'levels-route-repack'
  | 'levels-route-misc'
  | 'moderation'
  | 'image-factory'
  | 'zip-processor'
  | 'spaces-download';

export interface Workspace {
  /** Absolute path to the workspace root for this lease. Auto-removed in `finally`. */
  readonly dir: string;
  /** Aborts on global shutdown OR when the optional `parentSignal` aborts. */
  readonly signal: AbortSignal;
  /** Path under {@link Workspace.dir}. Refuses any traversal attempt. */
  join(...p: string[]): string;
  /** Atomic write under the workspace. `rel` is relative to {@link Workspace.dir}. */
  writeAtomic(rel: string, data: Buffer | string): Promise<void>;
  /** Atomic streaming write under the workspace; honours the workspace signal. */
  writeStreamAtomic(rel: string, source: Readable): Promise<void>;
  /** Move an existing absolute path into the workspace at relative `rel`. */
  renameInto(srcAbs: string, rel: string): Promise<void>;
  /** Throws if the workspace's signal has fired. */
  throwIfAborted(): void;
}

interface WithWorkspaceOptions {
  /** External signal (e.g. request close, parent operation abort) combined with the global one. */
  parentSignal?: AbortSignal;
  /** Stable subdir under `<root>/<domain>/` so concurrent runs for the same key don't collide
   * but still share an organisational namespace. */
  key?: string;
}

const activeWorkspaces = new Set<{ dir: string; controller: AbortController }>();
let bootSweepPromise: Promise<void> | null = null;

/** Lazy-initialised once on first lease (or via {@link sweepWorkspaceRootOnBoot}). */
async function ensureRootExists(): Promise<void> {
  await fs.promises.mkdir(WORKSPACE_ROOT, { recursive: true });
}

/**
 * Boot-time one-shot sweep: deletes any orphan workspace dirs left behind by prior SIGKILL.
 * Idempotent; safe to call multiple times.
 */
export function sweepWorkspaceRootOnBoot(): Promise<void> {
  if (bootSweepPromise) return bootSweepPromise;
  bootSweepPromise = (async () => {
    try {
      await ensureRootExists();
      const domains = await fs.promises.readdir(WORKSPACE_ROOT, { withFileTypes: true });
      for (const dEntry of domains) {
        if (!dEntry.isDirectory()) continue;
        const domainPath = path.join(WORKSPACE_ROOT, dEntry.name);
        await fs.promises.rm(domainPath, { recursive: true, force: true }).catch(err => {
          logger.warn(`Boot sweep: failed to remove ${domainPath}:`, err);
        });
      }
      logger.info(`Workspace boot sweep complete (${WORKSPACE_ROOT})`);
    } catch (error) {
      logger.warn('Workspace boot sweep failed:', error);
    }
  })();
  return bootSweepPromise;
}

/**
 * Combine the global shutdown signal, an optional parent signal, and a per-lease controller.
 */
function buildSignal(parentSignal: AbortSignal | undefined): {
  signal: AbortSignal;
  controller: AbortController;
} {
  const controller = new AbortController();
  const globalSignal = getGlobalAbortSignal();

  const fwd = (src: AbortSignal) => {
    if (src.aborted) {
      if (!controller.signal.aborted) controller.abort(src.reason);
    } else {
      const onAbort = () => {
        if (!controller.signal.aborted) controller.abort(src.reason);
      };
      src.addEventListener('abort', onAbort, { once: true });
    }
  };
  fwd(globalSignal);
  if (parentSignal) fwd(parentSignal);
  return { signal: controller.signal, controller };
}

function safeJoin(baseDir: string, parts: string[]): string {
  const target = path.resolve(baseDir, ...parts);
  const baseAbs = path.resolve(baseDir);
  const baseWithSep = baseAbs.endsWith(path.sep) ? baseAbs : baseAbs + path.sep;
  if (target !== baseAbs && !target.startsWith(baseWithSep)) {
    throw new Error(`Workspace path traversal refused: ${parts.join('/')}`);
  }
  return target;
}

/**
 * Create a fresh workspace directory, run `fn`, then guarantee its removal in `finally` —
 * regardless of success, throw, or signal-driven abort. The workspace is registered with the
 * shutdown coordinator so SIGINT/SIGTERM will fire its signal and remove the dir.
 *
 * Layout: `<WORKSPACE_ROOT>/<domain>/[<key>/]<runId>/`
 */
export async function withWorkspace<T>(
  domain: WorkspaceDomain,
  fn: (ws: Workspace) => Promise<T>,
  opts?: WithWorkspaceOptions,
): Promise<T> {
  await ensureRootExists();
  const runId = crypto.randomBytes(8).toString('hex');
  const segments: string[] = [domain];
  if (opts?.key) segments.push(opts.key);
  segments.push(runId);
  const dir = path.join(WORKSPACE_ROOT, ...segments);
  await fs.promises.mkdir(dir, { recursive: true });

  const { signal, controller } = buildSignal(opts?.parentSignal);
  const handle = { dir, controller };
  activeWorkspaces.add(handle);

  const ws: Workspace = {
    dir,
    signal,
    join: (...p) => safeJoin(dir, p),
    writeAtomic: async (rel, data) => {
      const target = safeJoin(dir, [rel]);
      await writeFileAtomic(target, data);
    },
    writeStreamAtomic: async (rel, source) => {
      const target = safeJoin(dir, [rel]);
      await writeStreamAtomic(target, source, { signal });
    },
    renameInto: async (srcAbs, rel) => {
      const target = safeJoin(dir, [rel]);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.rename(srcAbs, target);
    },
    throwIfAborted: () => {
      if (signal.aborted) {
        const reason = signal.reason instanceof Error
          ? signal.reason
          : new Error(String(signal.reason ?? 'aborted'));
        throw reason;
      }
    },
  };

  try {
    return await fn(ws);
  } finally {
    activeWorkspaces.delete(handle);
    await safeRemoveUnderRoot(dir, WORKSPACE_ROOT).catch(err => {
      logger.warn(`Workspace cleanup failed for ${dir}:`, err);
    });
  }
}

/**
 * Register the workspace shutdown step. Aborting all active workspaces causes their `fn`s
 * to bubble out and hit the `finally` cleanup. Then we also wipe the root tree as belt + suspenders.
 */
function registerWorkspaceShutdown(): void {
  registerShutdownStep({
    name: 'workspaces',
    priority: 20,
    fn: async () => {
      for (const handle of activeWorkspaces) {
        if (!handle.controller.signal.aborted) {
          handle.controller.abort(new Error('shutdown'));
        }
      }
      // Give in-flight finallies a moment to run.
      await new Promise(r => setTimeout(r, 250));
      // Suspenders: nuke whatever is left.
      try {
        await fs.promises.rm(WORKSPACE_ROOT, { recursive: true, force: true });
      } catch (error) {
        logger.warn('Workspace root removal on shutdown failed:', error);
      }
    },
  });
}

registerWorkspaceShutdown();
