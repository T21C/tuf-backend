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
  return sample.startsWith('<!') || 
    sample.startsWith('<html') ||
    sample.includes('uc-warning-caption') ||
    sample.includes('id="download-form"') ||
    sample.includes("id='download-form'") ||
    sample.includes('Google Drive')
  
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
  } catch (e) {
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

  let response = await axios.get<ArrayBuffer>(resolved, buildAxiosGetConfig(options));

  let buffer = Buffer.from(response.data);

  if (bufferLooksLikeHtml(buffer) && mayBeDriveInterstitial) {
    const html = buffer.toString('utf8');
    const confirmUrl = parseGoogleDriveVirusScanConfirmUrl(html);
    if (!confirmUrl) {
      throw {
        error:
          'Google Drive returned a virus-scan confirmation page that could not be parsed. Open the link in a browser or use a direct /uc?export=download style URL.',
        code: 400,
      };
    }
    response = await axios.get<ArrayBuffer>(confirmUrl, buildAxiosGetConfig(options));
    buffer = Buffer.from(response.data);
  }

  if (bufferLooksLikeHtml(buffer)) {
    if (mayBeDriveInterstitial) {
      const html = buffer.toString('utf8');
      const second = parseGoogleDriveVirusScanConfirmUrl(html);
      if (second) {
        response = await axios.get<ArrayBuffer>(second, buildAxiosGetConfig(options));
        buffer = Buffer.from(response.data);
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
