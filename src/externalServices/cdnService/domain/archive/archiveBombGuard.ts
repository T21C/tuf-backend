import type { ArchiveEntry } from '@/externalServices/cdnService/infra/archive/archiveService.js';
import { CDN_CONFIG } from '@/externalServices/cdnService/config.js';
import { CdnIngestUserError } from '@/externalServices/cdnService/jobs/cdnIngestErrors.js';

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) {
    return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
  }
  if (n >= 1024 * 1024) {
    return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  }
  return `${Math.max(1, Math.round(n / 1024))} KiB`;
}

/**
 * Reject archives whose central-directory metadata indicates decompression bombs
 * (tiny compressed payload, huge declared uncompressed size) before 7z extracts.
 */
export function assertArchiveDecompressionSafe(
  entries: ArchiveEntry[],
  archiveFileSizeBytes: number,
): void {
  const {
    maxArchiveEntryCount,
    maxEntryUncompressedBytes,
    maxTotalUncompressedBytes,
    maxCompressionRatio,
  } = CDN_CONFIG.archiveBombLimits;

  if (entries.length > maxArchiveEntryCount) {
    throw new CdnIngestUserError(
      `Archive contains too many entries (${entries.length}; max ${maxArchiveEntryCount}).`,
    );
  }

  let totalUncompressed = 0;
  for (const entry of entries) {
    if (entry.isDirectory) {
      continue;
    }

    if (entry.size > maxEntryUncompressedBytes) {
      throw new CdnIngestUserError(
        `Archive entry "${entry.relativePath}" is too large when decompressed ` +
          `(${formatBytes(entry.size)}; max ${formatBytes(maxEntryUncompressedBytes)}).`,
      );
    }

    totalUncompressed += entry.size;
    if (totalUncompressed > maxTotalUncompressedBytes) {
      throw new CdnIngestUserError(
        `Archive would expand to too much data when decompressed ` +
          `(over ${formatBytes(maxTotalUncompressedBytes)} total).`,
      );
    }
  }

  if (archiveFileSizeBytes > 0 && totalUncompressed > 0) {
    const ratio = totalUncompressed / archiveFileSizeBytes;
    if (ratio > maxCompressionRatio) {
      throw new CdnIngestUserError(
        `Archive compression ratio is suspicious (${Math.round(ratio)}:1; max ${maxCompressionRatio}:1). ` +
          'The file may be a zip bomb.',
      );
    }
  }
}
