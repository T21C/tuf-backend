import axios, {type AxiosRequestConfig} from 'axios';
import AdmZip from 'adm-zip';

const MAX_ZIP_BYTES = 1000 * 1024 * 1024; // 1GB, aligned with chunked upload cap in migrator
const DOWNLOAD_TIMEOUT_MS = 120_000;

const DOWNLOAD_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
};

export function isValidHttpUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isGoogleDriveHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'drive.google.com' || h.endsWith('.drive.google.com') || h === 'drive.usercontent.google.com';
}

/** Google Drive view links → first-step download URL (may return HTML virus-scan interstitial). */
export function resolveDirectDownloadUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.includes('drive.google.com')) {
    const match = trimmed.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (match) {
      return `https://drive.usercontent.google.com/download?id=${match[1]}`;
    }
  }
  return trimmed;
}

/**
 * Decode minimal HTML entities needed for href / attribute values.
 */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function bufferLooksLikeHtml(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(4096, buf.length)).toString('utf8').trimStart();
  return (
    sample.startsWith('<!') ||
    sample.startsWith('<html') ||
    sample.includes('uc-warning-caption') ||
    sample.includes('id="download-form"') ||
    sample.includes("id='download-form'") ||
    sample.includes('Google Drive')
  );
}

/** Structured error for API responses (not logged as raw Axios dumps). */
export type ZipUrlDownloadFailure = {error: string; code: number};

export function asZipUrlDownloadFailure(err: unknown): ZipUrlDownloadFailure {
  if (typeof err === 'object' && err !== null) {
    const o = err as Record<string, unknown>;
    if (typeof o.error === 'string' && typeof o.code === 'number') {
      return {error: o.error, code: o.code};
    }
  }
  return normalizeZipUrlDownloadError(err);
}

export function normalizeZipUrlDownloadError(err: unknown): ZipUrlDownloadFailure {
  if (typeof err === 'object' && err !== null && 'error' in err && 'code' in err) {
    const o = err as {error?: unknown; code?: unknown};
    if (typeof o.error === 'string' && typeof o.code === 'number' && o.code >= 400 && o.code < 600) {
      return {error: o.error, code: o.code};
    }
  }

  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const body = err.response?.data;
    let detail = '';
    if (typeof body === 'string' && body.length > 0 && body.length < 500) {
      detail = body.trim().slice(0, 200);
    } else if (body && typeof body === 'object' && 'message' in body) {
      const m = (body as {message?: unknown}).message;
      if (typeof m === 'string') {
        detail = m.slice(0, 200);
      }
    }

    if (status === 404) {
      return {
        error: 'Remote file not found (404). The link may be wrong or the file was removed.',
        code: 404,
      };
    }
    if (status === 403) {
      return {
        error:
          'Remote host refused download (403). It may require sign-in or block automated access.',
        code: 403,
      };
    }
    if (status === 401) {
      return {error: 'Remote host requires authentication (401).', code: 401};
    }
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return {
        error: detail ? `Download failed (HTTP ${status}): ${detail}` : `Download failed (HTTP ${status}).`,
        code: status,
      };
    }
    if (typeof status === 'number' && status >= 500) {
      return {
        error: detail ? `Remote server error (HTTP ${status}).` : `Remote server error (HTTP ${status}).`,
        code: 502,
      };
    }

    const code = err.code;
    if (code === 'ECONNABORTED' || err.message?.toLowerCase().includes('timeout')) {
      return {error: 'Download timed out before completing.', code: 408};
    }
    if (code === 'ENOTFOUND') {
      return {error: 'Could not resolve download host (DNS).', code: 400};
    }
    if (code === 'ECONNRESET' || code === 'ETIMEDOUT') {
      return {error: 'Connection to download host was reset or timed out.', code: 502};
    }

    return {
      error: err.message || 'Download failed.',
      code: 502,
    };
  }

  if (err instanceof Error) {
    return {error: err.message, code: 502};
  }

  return {error: String(err), code: 502};
}

function hiddenInputValue(html: string, name: string): string | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nameFirst = new RegExp(
    `<input[^>]+name=["']${esc}["'][^>]*value=["']([^"']*)["']`,
    'i',
  );
  const m1 = html.match(nameFirst);
  if (m1?.[1] != null) {
    return decodeHtmlEntities(m1[1]);
  }
  const valueFirst = new RegExp(
    `<input[^>]+value=["']([^"']*)["'][^>]*name=["']${esc}["']`,
    'i',
  );
  const m2 = html.match(valueFirst);
  if (m2?.[1] != null) {
    return decodeHtmlEntities(m2[1]);
  }
  return null;
}

/**
 * Parse Google Drive "can't scan for viruses" HTML into a GET URL that returns the real file
 * (form#download-form: action + id, confirm, uuid, and optional `at`).
 */
export function parseGoogleDriveVirusScanConfirmUrl(html: string): string | null {
  const fullHref = html.match(
    /href=["'](https:\/\/drive\.usercontent\.google\.com\/download[^"'>\s]+)["']/i,
  );
  if (fullHref?.[1]) {
    try {
      const cleaned = decodeHtmlEntities(fullHref[1]).trim();
      const u = new URL(cleaned);
      if (u.hostname === 'drive.usercontent.google.com' && u.pathname.includes('download')) {
        return u.toString();
      }
    } catch {
      /* continue */
    }
  }

  if (!/id=["']download-form["']/i.test(html) && !/id='download-form'/i.test(html)) {
    return null;
  }

  const formOpen = html.match(/<form[^>]*id=["']download-form["'][^>]*>/i);
  if (!formOpen) {
    return null;
  }

  const formTag = formOpen[0];
  let action = 'https://drive.usercontent.google.com/download';
  const actionM = formTag.match(/\baction=["']([^"']+)["']/i);
  if (actionM?.[1]) {
    const raw = decodeHtmlEntities(actionM[1]).trim();
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      action = raw;
    } else if (raw.startsWith('/')) {
      action = `https://drive.usercontent.google.com${raw}`;
    }
  }

  const id = hiddenInputValue(html, 'id');
  if (!id) {
    return null;
  }

  const confirm = hiddenInputValue(html, 'confirm');
  const uuid = hiddenInputValue(html, 'uuid');
  let at = hiddenInputValue(html, 'at');
  if (!at) {
    const atM = html.match(/(?:\?|&)at=([^"&'\s<>]+)/i);
    if (atM?.[1]) {
      try {
        at = decodeURIComponent(decodeHtmlEntities(atM[1]));
      } catch {
        at = decodeHtmlEntities(atM[1]);
      }
    }
  }

  const u = new URL(action);
  u.searchParams.set('id', id);
  if (confirm) {
    u.searchParams.set('confirm', confirm);
  }
  if (uuid) {
    u.searchParams.set('uuid', uuid);
  }
  if (at) {
    u.searchParams.set('at', at);
  }

  return u.toString();
}

export function assertValidZipBuffer(buffer: Buffer): void {
  try {
    const zip = new AdmZip(buffer);
    zip.getEntries();
  } catch {
    throw {error: 'Downloaded file is not a valid zip archive', code: 400};
  }
}

export type ZipUrlDownloadProgress = {
  loaded: number;
  total: number;
  /** 0–100 when Content-Length is known; 0 while unknown. */
  percent: number;
};

export type DownloadZipFromUrlOptions = {
  /** Fires during transfer (axios onDownloadProgress). */
  onProgress?: (p: ZipUrlDownloadProgress) => void | Promise<void>;
  /** Optional abort signal (axios cancel). */
  signal?: AbortSignal;
};

function buildAxiosGetConfig(
  options: DownloadZipFromUrlOptions | undefined,
): AxiosRequestConfig<ArrayBuffer> {
  return {
    responseType: 'arraybuffer',
    timeout: DOWNLOAD_TIMEOUT_MS,
    maxContentLength: MAX_ZIP_BYTES,
    maxBodyLength: MAX_ZIP_BYTES,
    validateStatus: (status) => status === 200,
    headers: DOWNLOAD_HEADERS,
    signal: options?.signal,
    onDownloadProgress: (evt) => {
      const loaded = typeof evt.loaded === 'number' ? evt.loaded : 0;
      const total = typeof evt.total === 'number' && evt.total > 0 ? evt.total : 0;
      const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
      void options?.onProgress?.({loaded, total, percent});
    },
  };
}

async function axiosGetZipBuffer(
  url: string,
  options?: DownloadZipFromUrlOptions,
): Promise<ArrayBuffer> {
  try {
    const res = await axios.get<ArrayBuffer>(url, buildAxiosGetConfig(options));
    return res.data;
  } catch (e) {
    throw normalizeZipUrlDownloadError(e);
  }
}

export async function downloadZipFromUrl(
  url: string,
  options?: DownloadZipFromUrlOptions,
): Promise<Buffer> {
  let resolved = resolveDirectDownloadUrl(url);
  if (!resolved.startsWith('http://') && !resolved.startsWith('https://')) {
    resolved = `https://${resolved}`;
  }
  if (!isValidHttpUrl(resolved)) {
    throw {error: 'Invalid download URL', code: 400};
  }

  const firstHost = new URL(resolved).hostname;
  const mayBeDriveInterstitial = isGoogleDriveHost(firstHost);

  let buffer = Buffer.from(await axiosGetZipBuffer(resolved, options));

  if (bufferLooksLikeHtml(buffer) && mayBeDriveInterstitial) {
    const html = buffer.toString('utf8');
    const confirmUrl = parseGoogleDriveVirusScanConfirmUrl(html);
    if (!confirmUrl) {
      throw {
        error:
          'Link leads to a Google Drive page that could not be parsed. Open the link in a browser or use a direct /uc?export=download style URL.',
        code: 400,
      };
    }
    buffer = Buffer.from(await axiosGetZipBuffer(confirmUrl, options));
  }

  if (bufferLooksLikeHtml(buffer)) {
    if (mayBeDriveInterstitial) {
      const html = buffer.toString('utf8');
      const second = parseGoogleDriveVirusScanConfirmUrl(html);
      if (second) {
        buffer = Buffer.from(await axiosGetZipBuffer(second, options));
      }
    }
    if (bufferLooksLikeHtml(buffer)) {
      throw {
        error: 'Download URL returned HTML instead of a zip file (unexpected interstitial or login page).',
        code: 400,
      };
    }
  }

  if (buffer.length === 0) {
    throw {error: 'Downloaded file is empty', code: 400};
  }
  if (buffer.length > MAX_ZIP_BYTES) {
    throw {error: 'Downloaded file exceeds maximum allowed size', code: 400};
  }

  assertValidZipBuffer(buffer);
  return buffer;
}
