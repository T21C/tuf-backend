import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { logger } from '@/server/services/core/LoggerService.js';
import { createZip } from '@/externalServices/cdnService/infra/archive/archiveService.js';
import {
  assertValidArchiveBuffer,
  LEVEL_ZIP_IMPORT_MAX_BYTES,
} from '@/misc/utils/data/levelZipFromUrl.js';

/**
 * Steam Workshop → level zip import for upload-from-url.
 *
 * Ops: install SteamCMD on the host, set `STEAMCMD_PATH` to `steamcmd.exe` / `steamcmd.sh`.
 * Optional: `STEAMCMD_CWD`, `STEAM_WORKSHOP_APP_ID` (default ADOFAI `977950`),
 * `STEAM_USERNAME` + `STEAM_PASSWORD` (if unset, uses `+login anonymous`).
 * `STEAMCMD_TIMEOUT_MS` — default 45 minutes.
 */

const LOG_TAIL = 2048;

/** Published file id as decimal string (may exceed JS safe integer). */
export function parseSteamWorkshopPublishedFileId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const steamCommunityFile = trimmed.match(/^steam:\/\/url\/CommunityFilePage\/(\d+)\/?$/i);
  if (steamCommunityFile?.[1]) {
    return steamCommunityFile[1];
  }

  try {
    const u = new URL(trimmed);
    const host = u.hostname.toLowerCase();
    if (host !== 'steamcommunity.com' && !host.endsWith('.steamcommunity.com')) {
      return null;
    }
    const p = u.pathname.toLowerCase();
    const isFileDetails =
      p.includes('/sharedfiles/filedetails') || p.includes('/workshop/filedetails');
    if (!isFileDetails) {
      return null;
    }
    const id = u.searchParams.get('id');
    if (id && /^\d+$/.test(id)) {
      return id;
    }
  } catch {
    /* not an http(s) URL */
  }

  return null;
}

export type SteamWorkshopDownloadPhase = 'steamcmd' | 'pack';

export type DownloadSteamWorkshopItemToZipBufferOptions = {
  signal?: AbortSignal;
  onPhase?: (phase: SteamWorkshopDownloadPhase, detail?: { zipPercent?: number }) => void | Promise<void>;
};

function steamCmdTimeoutMs(): number {
  const raw = process.env.STEAMCMD_TIMEOUT_MS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }
  return 45 * 60 * 1000;
}

function workshopAppId(): string {
  const id = (process.env.STEAM_WORKSHOP_APP_ID ?? '977950').trim();
  if (!/^\d+$/.test(id)) {
    throw { error: 'STEAM_WORKSHOP_APP_ID must be a numeric Steam app id', code: 500 };
  }
  return id;
}

function trimForLog(s: string, max = LOG_TAIL): string {
  const t = s.trim();
  if (t.length <= max) {
    return t;
  }
  return `…${t.slice(-max)}`;
}

async function runSteamCmd(
  executable: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: opts.cwd,
      windowsHide: true,
      env: process.env,
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (d: Buffer) => out.push(Buffer.from(d)));
    child.stderr?.on('data', (d: Buffer) => err.push(Buffer.from(d)));

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      fn();
    };

    const killTree = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 5000);
    };

    const onAbort = () => {
      killTree();
    };

    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
      } else {
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    timeoutId = setTimeout(() => {
      logger.warn('steamcmd: timeout, killing process', { timeoutMs: opts.timeoutMs });
      killTree();
    }, opts.timeoutMs);

    child.on('error', (e) => {
      finish(() => {
        if (opts.signal) {
          opts.signal.removeEventListener('abort', onAbort);
        }
        reject(e);
      });
    });

    child.on('close', (code) => {
      finish(() => {
        if (opts.signal) {
          opts.signal.removeEventListener('abort', onAbort);
        }
        resolve({
          code,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
        });
      });
    });
  });
}

async function assertNonEmptyDir(dir: string): Promise<void> {
  const entries = await fs.promises.readdir(dir);
  if (entries.length === 0) {
    throw { error: 'Steam Workshop download produced an empty folder', code: 502 };
  }
}

/**
 * Download a workshop item via SteamCMD, pack its content folder into a store-mode zip, validate.
 */
export async function downloadSteamWorkshopItemToZipBuffer(
  publishedFileId: string,
  options?: DownloadSteamWorkshopItemToZipBufferOptions,
): Promise<Buffer> {
  if (!/^\d+$/.test(publishedFileId)) {
    throw { error: 'Invalid Steam Workshop item id', code: 400 };
  }

  const steamcmdPath = process.env.STEAMCMD_PATH?.trim();
  if (!steamcmdPath) {
    throw {
      error: 'Steam Workshop import is not configured (set STEAMCMD_PATH on the server).',
      code: 503,
    };
  }

  const appId = workshopAppId();
  const workspaceDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tuf-steam-workshop-'));
  const zipPath = path.join(workspaceDir, `workshop-${publishedFileId}.zip`);
  const itemDir = path.join(workspaceDir, 'steamapps', 'workshop', 'content', appId, publishedFileId);

  const user = process.env.STEAM_USERNAME?.trim();
  const pass = process.env.STEAM_PASSWORD?.trim();
  const loginArgs = user && pass ? (['+login', user, pass] as const) : (['+login', 'anonymous'] as const);

  const args = [
    '+force_install_dir',
    workspaceDir,
    ...loginArgs,
    '+workshop_download_item',
    appId,
    publishedFileId,
    '+quit',
  ];

  const cwd = process.env.STEAMCMD_CWD?.trim() || undefined;
  const timeoutMs = steamCmdTimeoutMs();

  try {
    await options?.onPhase?.('steamcmd');

    let result;
    try {
      result = await runSteamCmd(steamcmdPath, args, {
        cwd,
        timeoutMs,
        signal: options?.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw {
          error: `SteamCMD executable not found at STEAMCMD_PATH: ${steamcmdPath}`,
          code: 503,
        };
      }
      throw { error: `SteamCMD failed to start: ${msg}`, code: 502 };
    }

    const combined = `${result.stdout}\n${result.stderr}`;
    const folderReady = fs.existsSync(itemDir);
    if (result.code !== 0 && result.code !== null) {
      logger.warn('steamcmd: non-zero exit', {
        exitCode: result.code,
        folderReady,
        stderrTail: trimForLog(result.stderr),
        stdoutTail: trimForLog(result.stdout),
      });
    }

    if (!folderReady) {
      logger.warn('steamcmd: workshop content folder missing', {
        exitCode: result.code,
        itemDir,
        stderrTail: trimForLog(result.stderr),
        stdoutTail: trimForLog(result.stdout),
      });
      throw {
        error: `Steam Workshop download failed (exit ${result.code ?? 'unknown'}). ${trimForLog(combined, 400)}`,
        code: 502,
      };
    }

    await assertNonEmptyDir(itemDir);

    if (result.code !== 0 && result.code !== null && !/Success\.\s*Downloaded item/i.test(combined)) {
      throw {
        error: `Steam Workshop download may be incomplete (exit ${result.code}). ${trimForLog(combined, 400)}`,
        code: 502,
      };
    }

    await options?.onPhase?.('pack');
    await createZip(itemDir, zipPath, {
      signal: options?.signal,
      onZipProgress: (pct) => void options?.onPhase?.('pack', { zipPercent: pct }),
    });

    const stat = await fs.promises.stat(zipPath);
    if (stat.size > LEVEL_ZIP_IMPORT_MAX_BYTES) {
      throw { error: 'Packed workshop zip exceeds maximum allowed size', code: 400 };
    }

    const buf = await fs.promises.readFile(zipPath);
    await assertValidArchiveBuffer(buf, `workshop-${publishedFileId}.zip`);
    return buf;
  } finally {
    try {
      await fs.promises.rm(workspaceDir, { recursive: true, force: true });
    } catch (e) {
      logger.debug('steam workshop import: failed to remove temp dir', {
        workspaceDir,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
