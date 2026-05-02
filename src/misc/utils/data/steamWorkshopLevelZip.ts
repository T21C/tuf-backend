import axios from 'axios';
import type { Readable } from 'stream';
import {
  assertValidArchiveBuffer,
  LEVEL_ZIP_IMPORT_MAX_BYTES,
  normalizeZipUrlDownloadError,
  type ZipUrlDownloadProgress,
} from '@/misc/utils/data/levelZipFromUrl.js';

/**
 * Steam Workshop → level zip import for upload-from-url.
 *
 * Main API delegates SteamCMD + packing to `steam-workshop-agent` over HTTP (e.g. Tailscale).
 * Configure `STEAM_WORKSHOP_AGENT_URL`, `STEAM_WORKSHOP_AGENT_SECRET`, optional
 * `STEAM_WORKSHOP_AGENT_TIMEOUT_MS` (default 45 min), optional `STEAM_WORKSHOP_APP_ID`
 * passed through to the agent in the JSON body.
 *
 * The zip body is read as a stream so `onDownloadProgress` reflects Tailscale/HTTP transfer
 * (0–100 when `Content-Length` is present), matching direct cloud URL downloads.
 */

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

export type SteamWorkshopDownloadPhase = 'agent';

export type DownloadSteamWorkshopItemToZipBufferOptions = {
  signal?: AbortSignal;
  /** Fires once before the HTTP request is sent (e.g. “waiting for agent”). */
  onPhase?: (phase: SteamWorkshopDownloadPhase) => void | Promise<void>;
  /** Bytes received while reading the agent’s zip response (same shape as direct URL import). */
  onProgress?: (p: ZipUrlDownloadProgress) => void | Promise<void>;
};

function agentTimeoutMs(): number {
  const raw = process.env.STEAM_WORKSHOP_AGENT_TIMEOUT_MS?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }
  return 45 * 60 * 1000;
}

function agentBaseUrl(): string | null {
  const u = process.env.STEAM_WORKSHOP_AGENT_URL?.trim().replace(/\/+$/, '');
  return u || null;
}

function parseContentLength(headers: Record<string, unknown>): number {
  const raw = headers['content-length'];
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (s == null || s === '') {
    return 0;
  }
  const n = parseInt(String(s), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function parseAgentErrorBody(data: Buffer): { error: string; code: number } | null {
  try {
    const txt = data.toString('utf8').trim();
    if (!txt || txt.startsWith('PK')) {
      return null;
    }
    const j = JSON.parse(txt) as { error?: unknown; code?: unknown };
    if (typeof j.error === 'string' && typeof j.code === 'number') {
      return { error: j.error, code: j.code };
    }
  } catch {
    /* not JSON */
  }
  return null;
}

async function readStreamToBufferLimit(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let loaded = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    loaded += b.length;
    chunks.push(b);
    if (loaded >= maxBytes) {
      break;
    }
  }
  return Buffer.concat(chunks);
}

async function readZipStreamWithProgress(
  stream: Readable,
  options: {
    totalHint: number;
    maxBytes: number;
    signal?: AbortSignal;
    onProgress?: (p: ZipUrlDownloadProgress) => void | Promise<void>;
  },
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let loaded = 0;
  let total = options.totalHint;

  const onAbort = () => {
    stream.destroy();
  };
  if (options.signal) {
    if (options.signal.aborted) {
      onAbort();
      throw { error: 'Steam Workshop download was cancelled', code: 499 };
    }
    options.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    for await (const chunk of stream) {
      if (options.signal?.aborted) {
        throw { error: 'Steam Workshop download was cancelled', code: 499 };
      }
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      loaded += b.length;
      if (loaded > options.maxBytes) {
        throw { error: 'Downloaded workshop zip exceeds maximum allowed size', code: 400 };
      }
      chunks.push(b);
      const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
      await options.onProgress?.({ loaded, total, percent });
    }
  } finally {
    if (options.signal) {
      options.signal.removeEventListener('abort', onAbort);
    }
  }

  const buf = Buffer.concat(chunks);
  if (total === 0 && buf.length > 0) {
    await options.onProgress?.({ loaded: buf.length, total: buf.length, percent: 100 });
  } else if (total > 0 && loaded >= total) {
    await options.onProgress?.({ loaded, total, percent: 100 });
  }

  return buf;
}

/**
 * Ask steam-workshop-agent for a store-mode zip of the workshop item; validate like a remote archive.
 */
export async function downloadSteamWorkshopItemToZipBuffer(
  publishedFileId: string,
  options?: DownloadSteamWorkshopItemToZipBufferOptions,
): Promise<Buffer> {
  if (!/^\d+$/.test(publishedFileId)) {
    throw { error: 'Invalid Steam Workshop item id', code: 400 };
  }

  const base = agentBaseUrl();
  const secret = process.env.STEAM_WORKSHOP_AGENT_SECRET?.trim();
  if (!base || !secret) {
    throw {
      error:
        'Steam Workshop import is not configured (set STEAM_WORKSHOP_AGENT_URL and STEAM_WORKSHOP_AGENT_SECRET on the API server).',
      code: 503,
    };
  }

  const appIdEnv = process.env.STEAM_WORKSHOP_APP_ID?.trim();
  const body: { publishedFileId: string; appId?: string } = { publishedFileId };
  if (appIdEnv && /^\d+$/.test(appIdEnv)) {
    body.appId = appIdEnv;
  }

  await options?.onPhase?.('agent');

  const url = `${base}/v1/workshop/item.zip`;

  try {
    const res = await axios.post<Readable>(url, body, {
      responseType: 'stream',
      timeout: agentTimeoutMs(),
      maxContentLength: LEVEL_ZIP_IMPORT_MAX_BYTES + 256,
      maxBodyLength: 65536,
      signal: options?.signal,
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      validateStatus: () => true,
    });

    if (res.status !== 200) {
      const errBuf = await readStreamToBufferLimit(res.data, 65536);
      const parsed = parseAgentErrorBody(errBuf);
      if (parsed) {
        throw { error: parsed.error, code: parsed.code };
      }
      throw {
        error: `Steam Workshop agent returned HTTP ${res.status}`,
        code: res.status >= 400 && res.status < 600 ? res.status : 502,
      };
    }

    const totalFromHeader = parseContentLength(res.headers as Record<string, unknown>);
    await options?.onProgress?.({ loaded: 0, total: totalFromHeader, percent: 0 });

    const buf = await readZipStreamWithProgress(res.data, {
      totalHint: totalFromHeader,
      maxBytes: LEVEL_ZIP_IMPORT_MAX_BYTES,
      signal: options?.signal,
      onProgress: options?.onProgress,
    });

    if (buf.length === 0) {
      throw { error: 'Steam Workshop agent returned an empty zip', code: 502 };
    }
    if (buf.length > LEVEL_ZIP_IMPORT_MAX_BYTES) {
      throw { error: 'Downloaded workshop zip exceeds maximum allowed size', code: 400 };
    }

    await assertValidArchiveBuffer(buf, `workshop-${publishedFileId}.zip`);
    return buf;
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      if (err.code === 'ERR_CANCELED') {
        throw { error: 'Steam Workshop download was cancelled', code: 499 };
      }
      if (err.code === 'ECONNABORTED') {
        throw { error: 'Steam Workshop agent request timed out', code: 504 };
      }
      if (err.response?.data && typeof (err.response.data as Readable).read === 'function') {
        try {
          const errBuf = await readStreamToBufferLimit(err.response.data as Readable, 65536);
          const parsed = parseAgentErrorBody(errBuf);
          if (parsed) {
            throw { error: parsed.error, code: parsed.code };
          }
        } catch (inner) {
          if (typeof inner === 'object' && inner !== null && 'error' in inner && 'code' in inner) {
            throw inner;
          }
        }
      }
      const msg = err.message || 'Steam Workshop agent request failed';
      throw { error: msg, code: 502 };
    }
    if (typeof err === 'object' && err !== null && 'error' in err && 'code' in err) {
      const o = err as { error?: unknown; code?: unknown };
      if (typeof o.error === 'string' && typeof o.code === 'number') {
        throw err;
      }
    }
    const fail = normalizeZipUrlDownloadError(err);
    throw { error: fail.error, code: fail.code >= 400 && fail.code < 600 ? fail.code : 502 };
  }
}
