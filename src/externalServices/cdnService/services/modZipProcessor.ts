import fs from 'fs';
import {randomUUID} from 'crypto';
import CdnFile from '@/models/cdn/CdnFile.js';
import {CDN_CONFIG} from '@/externalServices/cdnService/config.js';
import {spacesStorage} from '@/externalServices/cdnService/infra/storage/spacesStorage.js';
import {listEntries} from '@/externalServices/cdnService/infra/archive/archiveService.js';
import {cdnLocalTemp} from '@/externalServices/cdnService/infra/workspaces/cdnLocalTempManager.js';
import {CdnIngestUserError} from '@/externalServices/cdnService/jobs/cdnIngestErrors.js';
import {
  assertModZipEntriesSafe,
  assertModZipFilename,
  assertModZipSize,
  hasZipMagic,
  sanitiseModZipStorageName,
} from '@/server/services/mods/modZipValidate.js';

function asUserError(error: unknown): CdnIngestUserError {
  if (error instanceof CdnIngestUserError) return error;
  const message = error instanceof Error ? error.message : 'Invalid zip';
  return new CdnIngestUserError(message);
}

async function readHeadBytes(filePath: string, length = 4): Promise<Uint8Array> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const {bytesRead} = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function ingestModZip(options: {
  filePath: string;
  originalname: string;
  size: number;
}): Promise<{fileId: string; url: string; originalFilename: string}> {
  try {
    assertModZipFilename(options.originalname);
    assertModZipSize(options.size);
    const head = await readHeadBytes(options.filePath);
    if (!hasZipMagic(head)) {
      throw new CdnIngestUserError('File is not a zip archive');
    }
    const entries = await listEntries(options.filePath);
    assertModZipEntriesSafe(entries, options.size);

    const fileId = randomUUID();
    const originalFilename = sanitiseModZipStorageName(options.originalname);
    const storageKey = `zips/mods/${fileId}/${originalFilename}`;
    await spacesStorage.uploadFile(options.filePath, storageKey, 'application/zip');

    await CdnFile.create({
      id: fileId,
      type: 'MODZIP',
      filePath: storageKey,
      metadata: {
        originalZip: {
          name: originalFilename,
          path: storageKey,
          size: options.size,
          originalFilename,
        },
      },
    });

    return {
      fileId,
      url: `${CDN_CONFIG.baseUrl}/${fileId}`,
      originalFilename,
    };
  } catch (error) {
    throw asUserError(error);
  }
}

export function cleanupModZipTemp(filePath: string | undefined): void {
  if (!filePath) return;
  cdnLocalTemp.cleanupFiles(filePath);
}
