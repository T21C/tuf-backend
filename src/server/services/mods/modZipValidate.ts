import {
  MOD_ZIP_MAX_BYTES,
  MOD_ZIP_MAX_COMPRESSION_RATIO,
  MOD_ZIP_MAX_ENTRY_COUNT,
  MOD_ZIP_MAX_ENTRY_UNCOMPRESSED_BYTES,
  MOD_ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES,
} from './modZipLimits.js';

export type ModZipArchiveEntry = {
  relativePath: string;
  size: number;
  isDirectory: boolean;
};

const ZIP_LOCAL_FILE = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
const ZIP_EMPTY = new Uint8Array([0x50, 0x4b, 0x05, 0x06]);
const ZIP_SPANNED = new Uint8Array([0x50, 0x4b, 0x07, 0x08]);

function startsWithMagic(bytes: Uint8Array, magic: Uint8Array): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

export function isZipFilename(name: string): boolean {
  return name.trim().toLowerCase().endsWith('.zip');
}

const STORAGE_NAME_MAX = 180;

/** Object-key basename for a hosted mod zip, preserving the uploaded filename. */
export function sanitiseModZipStorageName(originalname: string): string {
  const nfc = String(originalname || '')
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F]/g, '');
  const base = nfc.split(/[/\\]/).pop()?.trim() || '';
  const cleaned = base.replace(/[<>:"|?*]/g, '_').replace(/^\.+/, '');
  if (!cleaned.toLowerCase().endsWith('.zip')) return 'mod.zip';
  const stem = cleaned.slice(0, -4);
  if (!stem) return 'mod.zip';
  const sliced = stem.length > STORAGE_NAME_MAX ? stem.slice(0, STORAGE_NAME_MAX) : stem;
  return `${sliced}.zip`;
}

export function displayNameFromModZipMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const zip = (metadata as {originalZip?: {originalFilename?: unknown; name?: unknown}}).originalZip;
  const raw =
    typeof zip?.originalFilename === 'string'
      ? zip.originalFilename
      : typeof zip?.name === 'string'
        ? zip.name
        : '';
  const base = raw.split(/[/\\]/).pop()?.trim() || '';
  return base || null;
}

export function isModReleaseSourceLocked(source: string | null | undefined): boolean {
  return source === 'hosted';
}

export function assertModZipFilename(name: string): void {
  if (!isZipFilename(name)) {
    throw new Error('File must be a .zip');
  }
}

export function assertModZipSize(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new Error('Zip is empty');
  }
  if (bytes > MOD_ZIP_MAX_BYTES) {
    throw new Error(`Zip must be at most ${Math.round(MOD_ZIP_MAX_BYTES / (1024 * 1024))} MiB`);
  }
}

export function hasZipMagic(bytes: Uint8Array): boolean {
  return (
    startsWithMagic(bytes, ZIP_LOCAL_FILE) ||
    startsWithMagic(bytes, ZIP_EMPTY) ||
    startsWithMagic(bytes, ZIP_SPANNED)
  );
}

export function archiveEntryPathIsUnsafe(relativePath: string): boolean {
  const trimmed = String(relativePath || '').replace(/\\/g, '/');
  if (!trimmed) return true;
  if (trimmed.startsWith('/') || trimmed.includes('\0')) return true;
  const parts = trimmed.split('/');
  return parts.some((part) => part === '..');
}

export function assertModZipEntriesSafe(
  entries: ModZipArchiveEntry[],
  archiveFileSizeBytes: number,
): void {
  const files = entries.filter((entry) => !entry.isDirectory);
  if (files.length === 0) {
    throw new Error('Zip has no files');
  }
  if (entries.length > MOD_ZIP_MAX_ENTRY_COUNT) {
    throw new Error(`Zip contains too many entries (max ${MOD_ZIP_MAX_ENTRY_COUNT})`);
  }

  let totalUncompressed = 0;
  for (const entry of entries) {
    if (archiveEntryPathIsUnsafe(entry.relativePath)) {
      throw new Error('Zip contains an unsafe path');
    }
    if (entry.isDirectory) continue;
    if (entry.size > MOD_ZIP_MAX_ENTRY_UNCOMPRESSED_BYTES) {
      throw new Error('Zip contains a file that is too large when decompressed');
    }
    totalUncompressed += entry.size;
    if (totalUncompressed > MOD_ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error('Zip would expand to too much data when decompressed');
    }
  }

  if (archiveFileSizeBytes > 0 && totalUncompressed > 0) {
    const ratio = totalUncompressed / archiveFileSizeBytes;
    if (ratio > MOD_ZIP_MAX_COMPRESSION_RATIO) {
      throw new Error('Zip compression ratio is suspicious');
    }
  }
}
