import axios from 'axios';
import {
  assertValidArchiveBuffer,
  LEVEL_ZIP_IMPORT_MAX_BYTES,
  normalizeZipUrlDownloadError,
} from '@/misc/utils/data/levelZipFromUrl.js';

/**
 * Steam Workshop → level zip import for upload-from-url.
 *
 * Main API delegates SteamCMD + packing to `steam-workshop-agent` over HTTP (e.g. Tailscale).
 * Configure `STEAM_WORKSHOP_AGENT_URL`, `STEAM_WORKSHOP_AGENT_SECRET`, optional
 * `STEAM_WORKSHOP_AGENT_TIMEOUT_MS` (default 45 min), optional `STEAM_WORKSHOP_APP_ID`
 * passed through to the agent in the JSON body.
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
  onPhase?: (phase: SteamWorkshopDownloadPhase) => void | Promise<void>;
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

function parseAgentErrorBody(data: ArrayBuffer): { error: string; code: number } | null {
  try {
    const txt = Buffer.from(data).toString('utf8').trim();
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
    const res = await axios.post<ArrayBuffer>(url, body, {
      responseType: 'arraybuffer',
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
      const parsed = parseAgentErrorBody(res.data as ArrayBuffer);
      if (parsed) {
        throw { error: parsed.error, code: parsed.code };
      }
      throw {
        error: `Steam Workshop agent returned HTTP ${res.status}`,
        code: res.status >= 400 && res.status < 600 ? res.status : 502,
      };
    }

    const buf = Buffer.from(res.data as ArrayBuffer);
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
      if (err.response?.data instanceof ArrayBuffer) {
        const parsed = parseAgentErrorBody(err.response.data);
        if (parsed) {
          throw { error: parsed.error, code: parsed.code };
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
