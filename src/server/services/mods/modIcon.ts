import type {Request} from 'express';
import Mod from '@/models/misc/Mod.js';
import {logger} from '@/server/services/core/LoggerService.js';
import cdnService, {CdnError} from '@/server/services/core/CdnService.js';
import {getFileIdFromCdnUrl, isCdnUrl} from '@/misc/utils/Utility.js';
import {invalidatePublicModsCache} from './modCache.js';
import {indexCatalogMod} from './modSearchIndex.js';
import {serializeMod, type SerializedMod} from './serializeMod.js';

export async function deleteStoredModIcon(imageUrl: string | null | undefined): Promise<void> {
  if (!imageUrl || !isCdnUrl(imageUrl)) return;
  try {
    const oldFileId = getFileIdFromCdnUrl(imageUrl);
    if (oldFileId && (await cdnService.checkFileExists(oldFileId))) {
      await cdnService.deleteFile(oldFileId);
    }
  } catch (error) {
    logger.error('Error deleting mod icon from CDN:', error);
  }
}

export async function replaceModIcon(options: {
  mod: Mod;
  file: Express.Multer.File;
  postedByUserId?: string;
}): Promise<SerializedMod> {
  const result = await cdnService.uploadModIcon(options.file.buffer, options.file.originalname);
  const previous = options.mod.imageUrl;
  await options.mod.update({
    imageUrl: result.urls.original,
    ...(options.postedByUserId ? {postedByUserId: options.postedByUserId} : {}),
  });
  await deleteStoredModIcon(previous);
  await indexCatalogMod(options.mod.id);
  await invalidatePublicModsCache();
  return serializeMod(options.mod, {includeHidden: true});
}

export async function clearModIcon(options: {
  mod: Mod;
  postedByUserId?: string;
}): Promise<SerializedMod> {
  const previous = options.mod.imageUrl;
  await options.mod.update({
    imageUrl: null,
    ...(options.postedByUserId ? {postedByUserId: options.postedByUserId} : {}),
  });
  await deleteStoredModIcon(previous);
  await indexCatalogMod(options.mod.id);
  await invalidatePublicModsCache();
  return serializeMod(options.mod, {includeHidden: true});
}

export function uploadedIconFile(req: Request): Express.Multer.File | null {
  return req.file || null;
}

export {CdnError};
