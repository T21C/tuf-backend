import { Response } from 'express';
import crypto from 'crypto';
import Difficulty from '@/models/levels/Difficulty.js';
import CurationType from '@/models/curations/CurationType.js';
import LevelTag from '@/models/levels/LevelTag.js';
import { DirectiveConditionType, DirectiveCondition } from '@/server/interfaces/models/index.js';
import { DirectiveParser } from '@/misc/utils/data/directiveParser.js';
import cdnService, { CdnError } from '@/server/services/core/CdnService.js';
import { multerMemoryCdnImage5Mb } from '@/config/multerMemoryUploads.js';
import { logger } from '@/server/services/core/LoggerService.js';

/**
 * Shared module state + helpers used by every difficulties subrouter.
 *
 * `difficultiesHash` is read by `GET /hash` (cache-busting fingerprint for the
 * frontend difficulties/curation-types/tags bundle) and bumped by every writer.
 * The initial computation runs once at module-load via top-level `await`, which
 * keeps cold-start behavior identical to the pre-split monolith.
 */

export const tagIconUpload = multerMemoryCdnImage5Mb;
export const difficultyIconUpload = multerMemoryCdnImage5Mb;

let difficultiesHash = '';

async function calculateDifficultiesHash(): Promise<string> {
  try {
    const diffs = await Difficulty.findAll();
    const diffsList = diffs.map(diff => diff.toJSON());
    const curationTypes = await CurationType.findAll();
    const curationTypesList = curationTypes.map(type => type.toJSON());
    const tags = await LevelTag.findAll();
    const tagsList = tags.map(tag => tag.toJSON());

    const diffsString = JSON.stringify(diffsList);
    const curationTypesString = JSON.stringify(curationTypesList);
    const tagsString = JSON.stringify(tagsList);
    const hash = crypto.createHash('sha256').update(diffsString).digest('hex');
    const curationTypesHash = crypto.createHash('sha256').update(curationTypesString).digest('hex');
    const tagsHash = crypto.createHash('sha256').update(tagsString).digest('hex');
    return `${hash}-${curationTypesHash}-${tagsHash}` + (process.env.NODE_ENV === 'development' ? `-${Date.now()}` : '');
  } catch (error) {
    logger.error('Error calculating difficulties hash:', error);
    return '';
  }
}

export async function updateDifficultiesHash(): Promise<void> {
  difficultiesHash = await calculateDifficultiesHash();
}

export function getDifficultiesHash(): string {
  return difficultiesHash;
}

// Seed the hash once at import time. Preserves the original behavior where the
// first `GET /hash` after boot returned a populated value without waiting for a
// write to trigger recomputation.
await updateDifficultiesHash();

/**
 * Upload a difficulty icon buffer to the CDN and return the canonical URL.
 *
 * `isLegacy` toggles the filename prefix so legacy and primary icons live side
 * by side in CDN listings without overwriting each other.
 */
export async function uploadDifficultyIconToCdn(
  iconBuffer: Buffer,
  originalFilename: string,
  diffName: string,
  isLegacy = false,
): Promise<string> {
  const ext = (originalFilename.split('.').pop() || 'png').toLowerCase();
  const prefix = isLegacy ? 'legacy_' : '';
  const safeName = diffName.replace(/[^a-zA-Z0-9]/g, '_');
  const filename = `${prefix}${safeName}_${Date.now()}.${ext}`;
  const result = await cdnService.uploadDifficultyIcon(iconBuffer, filename);
  return result.urls.original || result.urls.medium;
}

/**
 * Best-effort cleanup of an old CDN icon file after a successful update.
 * Cleanup failures are logged but never propagated — the icon row has already
 * been swapped and the request has succeeded from the caller's perspective.
 */
export async function cleanupOldDifficultyIcon(
  oldFileId: string | null,
  context: { diffId: number; kind: 'icon' | 'legacyIcon'; newIconUrl: string | null },
): Promise<void> {
  if (!oldFileId) return;
  try {
    logger.debug('Cleaning up old difficulty icon from CDN', {
      diffId: context.diffId,
      kind: context.kind,
      oldFileId,
      newIconUrl: context.newIconUrl,
    });
    await cdnService.deleteFile(oldFileId);
    logger.debug('Successfully cleaned up old difficulty icon from CDN', {
      diffId: context.diffId,
      kind: context.kind,
      oldFileId,
    });
  } catch (cleanupError) {
    logger.error('Failed to clean up old difficulty icon from CDN:', {
      diffId: context.diffId,
      kind: context.kind,
      oldFileId,
      error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
    });
  }
}

/**
 * Send a standardized response for a `CdnError`, falling back to a generic
 * 500 for any other upload failure. Keeps route handlers free of repeated
 * try/catch boilerplate.
 */
export function sendCdnErrorResponse(res: Response, uploadError: unknown, logPrefix: string): Response {
  if (uploadError instanceof CdnError) {
    const statusCode = uploadError.code === 'VALIDATION_ERROR' ? 400 : 500;
    const errorResponse: any = {
      error: uploadError.message,
      code: uploadError.code,
    };
    if (uploadError.details) {
      if (uploadError.details.errors) errorResponse.errors = uploadError.details.errors;
      if (uploadError.details.warnings) errorResponse.warnings = uploadError.details.warnings;
      if (uploadError.details.metadata) errorResponse.metadata = uploadError.details.metadata;
    }
    logger.debug(`${logPrefix}:`, uploadError);
    return res.status(statusCode).json(errorResponse);
  }
  logger.error(`${logPrefix}:`, uploadError);
  return res.status(500).json({
    error: 'Failed to upload icon to CDN',
    details: uploadError instanceof Error ? uploadError.message : String(uploadError),
  });
}

/**
 * Validate a CUSTOM directive's `customFunction` expression by attempting to
 * parse it. Non-CUSTOM directives are skipped and treated as valid here —
 * their other fields are validated inline in the directive route handler.
 */
export function validateCustomDirective(condition: DirectiveCondition): { isValid: boolean; error?: string } {
  if (condition.type !== DirectiveConditionType.CUSTOM || !condition.customFunction) {
    return { isValid: true };
  }
  try {
    const parser = new DirectiveParser(condition.customFunction);
    parser.parse();
    return { isValid: true };
  } catch (error) {
    return {
      isValid: false,
      error: error instanceof Error ? error.message : 'Invalid custom directive format',
    };
  }
}

/**
 * Find the smallest positive integer that isn't currently occupied in
 * `difficulties.id`. Used when the client creates a difficulty without
 * specifying an explicit ID.
 */
export async function findSmallestUnoccupiedId(): Promise<number> {
  const allDifficulties = await Difficulty.findAll({
    attributes: ['id'],
    order: [['id', 'ASC']],
  });
  const existingIds = new Set(allDifficulties.map(d => d.id));

  let candidateId = 1;
  while (existingIds.has(candidateId)) {
    candidateId++;
  }
  return candidateId;
}
