import axios from 'axios';
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

/** Google Drive view links → direct download URL (same idea as legacy migrator). */
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

export function assertValidZipBuffer(buffer: Buffer): void {
  try {
    const zip = new AdmZip(buffer);
    zip.getEntries();
  } catch (e) {
    throw {error: 'Downloaded file is not a valid zip archive', code: 400};
  }
}

export async function downloadZipFromUrl(url: string): Promise<Buffer> {
  let resolved = resolveDirectDownloadUrl(url);
  if (!resolved.startsWith('http://') && !resolved.startsWith('https://')) {
    resolved = `https://${resolved}`;
  }
  if (!isValidHttpUrl(resolved)) {
    throw {error: 'Invalid download URL', code: 400};
  }

  const response = await axios.get<ArrayBuffer>(resolved, {
    responseType: 'arraybuffer',
    timeout: DOWNLOAD_TIMEOUT_MS,
    maxContentLength: MAX_ZIP_BYTES,
    maxBodyLength: MAX_ZIP_BYTES,
    validateStatus: (status) => status === 200,
    headers: DOWNLOAD_HEADERS,
  });

  const buffer = Buffer.from(response.data);
  if (buffer.length === 0) {
    throw {error: 'Downloaded file is empty', code: 400};
  }
  if (buffer.length > MAX_ZIP_BYTES) {
    throw {error: 'Downloaded file exceeds maximum allowed size', code: 400};
  }

  assertValidZipBuffer(buffer);
  return buffer;
}
