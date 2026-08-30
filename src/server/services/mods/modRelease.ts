import {Op} from 'sequelize';
import type {Request} from 'express';
import ModVersion from '@/models/misc/ModVersion.js';
import {logger} from '@/server/services/core/LoggerService.js';
import cdnService, {CdnError} from '@/server/services/core/CdnService.js';
import {getFileIdFromCdnUrl, isCdnUrl} from '@/misc/utils/Utility.js';
import {assertModZipFilename} from './modZipValidate.js';
import {createModVersion, deleteModVersion, updateModVersion} from './modCreate.js';

export {CdnError};

function releaseClientError(message: string): Error & {status: number} {
  const error = new Error(message) as Error & {status: number};
  error.status = 400;
  return error;
}

export async function deleteStoredModZip(downloadUrl: string | null | undefined): Promise<void> {
  if (!downloadUrl || !isCdnUrl(downloadUrl)) return;
  try {
    const fileId = getFileIdFromCdnUrl(downloadUrl);
    if (!fileId) return;
    if (await cdnService.checkFileExists(fileId)) {
      await cdnService.deleteFile(fileId);
    }
  } catch (error) {
    logger.error('Error deleting mod zip from CDN:', error);
  }
}

export async function deleteStoredModZipIfOrphan(
  downloadUrl: string | null | undefined,
  exceptVersionId?: number,
): Promise<void> {
  if (!downloadUrl || !isCdnUrl(downloadUrl)) return;
  const where: Record<string, unknown> = {downloadUrl};
  if (exceptVersionId != null) {
    where.id = {[Op.ne]: exceptVersionId};
  }
  const remaining = await ModVersion.count({where});
  if (remaining > 0) return;
  await deleteStoredModZip(downloadUrl);
}

export async function uploadModZipFromRequest(file: Express.Multer.File): Promise<string> {
  assertModZipFilename(file.originalname || '');
  const source = file.path || file.buffer;
  if (!source) {
    const error = new Error('No file uploaded');
    (error as Error & {status: number}).status = 400;
    throw error;
  }
  const result = await cdnService.uploadModZip(source, file.originalname);
  return result.url;
}

export async function resolveReleaseDownloadUrl(options: {
  file?: Express.Multer.File | null;
  githubUrl?: string;
  previousUrl?: string;
}): Promise<{downloadUrl: string; uploadedUrl?: string}> {
  if (options.file) {
    const downloadUrl = await uploadModZipFromRequest(options.file);
    return {downloadUrl, uploadedUrl: downloadUrl};
  }
  if (options.githubUrl) {
    return {downloadUrl: options.githubUrl};
  }
  if (options.previousUrl) {
    return {downloadUrl: options.previousUrl};
  }
  const error = new Error('Provide a zip file or a GitHub URL');
  (error as Error & {status: number}).status = 400;
  throw error;
}

export function uploadedReleaseFile(req: Request): Express.Multer.File | null {
  return req.file || null;
}

export async function createModRelease(options: {
  modId: number;
  version: string;
  notes: string | null;
  releasedAt: Date;
  downloadUrl: string;
}): Promise<ModVersion> {
  return createModVersion(options);
}

export async function updateModRelease(
  versionRow: ModVersion,
  patch: Partial<{version: string; downloadUrl: string; notes: string | null; releasedAt: Date}>,
): Promise<ModVersion> {
  const previousUrl = versionRow.downloadUrl;
  const updated = await updateModVersion(versionRow, patch);
  if (patch.downloadUrl && patch.downloadUrl !== previousUrl) {
    await deleteStoredModZipIfOrphan(previousUrl, updated.id);
  }
  return updated;
}

export async function removeModRelease(versionRow: ModVersion): Promise<void> {
  const url = versionRow.downloadUrl;
  const id = versionRow.id;
  await deleteModVersion(versionRow);
  await deleteStoredModZipIfOrphan(url, id);
}

export async function createReleaseFromParsed(
  modId: number,
  parsed: {version?: string; notes?: string | null; releasedAt?: Date; githubUrl?: string},
  file?: Express.Multer.File | null,
): Promise<ModVersion> {
  let uploadedUrl: string | undefined;
  try {
    const resolved = await resolveReleaseDownloadUrl({
      file,
      githubUrl: parsed.githubUrl,
    });
    uploadedUrl = resolved.uploadedUrl;
    return await createModRelease({
      modId,
      version: parsed.version || 'unspecified',
      notes: parsed.notes ?? null,
      releasedAt: parsed.releasedAt || new Date(),
      downloadUrl: resolved.downloadUrl,
    });
  } catch (error) {
    if (uploadedUrl) await deleteStoredModZip(uploadedUrl);
    throw error;
  }
}

export async function updateReleaseFromParsed(
  versionRow: ModVersion,
  parsed: {version?: string; notes?: string | null; releasedAt?: Date; githubUrl?: string},
  file?: Express.Multer.File | null,
): Promise<ModVersion> {
  let uploadedUrl: string | undefined;
  try {
    const patch: Partial<{version: string; downloadUrl: string; notes: string | null; releasedAt: Date}> = {};
    if (parsed.version !== undefined) patch.version = parsed.version;
    if (parsed.notes !== undefined) patch.notes = parsed.notes;
    if (parsed.releasedAt !== undefined) patch.releasedAt = parsed.releasedAt;
    if (file || parsed.githubUrl) {
      if (isCdnUrl(versionRow.downloadUrl)) {
        throw releaseClientError('Hosted zip releases cannot change source');
      }
      const resolved = await resolveReleaseDownloadUrl({
        file,
        githubUrl: parsed.githubUrl,
        previousUrl: versionRow.downloadUrl,
      });
      uploadedUrl = resolved.uploadedUrl;
      patch.downloadUrl = resolved.downloadUrl;
    }
    return await updateModRelease(versionRow, patch);
  } catch (error) {
    if (uploadedUrl) await deleteStoredModZip(uploadedUrl);
    throw error;
  }
}

export async function deleteAllModReleaseZips(modId: number): Promise<void> {
  const versions = await ModVersion.findAll({
    where: {modId},
    attributes: ['id', 'downloadUrl'],
  });
  const urls = [...new Set(versions.map((row) => row.downloadUrl).filter(Boolean))];
  await Promise.all(urls.map((url) => deleteStoredModZip(url)));
}
