import cdnService from '@/server/services/core/CdnService.js';
import { logger } from '@/server/services/core/LoggerService.js';

/**
 * Best-effort CDN delete used when a submission fails after the CDN upload
 * has already taken the file. Never throws.
 */
export async function cleanUpCdnFile(fileId: string | null | undefined): Promise<void> {
  if (!fileId) return;
  try {
    await cdnService.deleteFile(fileId);
    logger.debug('CDN file cleaned up successfully:', {
      fileId,
      timestamp: new Date().toISOString(),
    });
  } catch (cleanupError) {
    logger.error('Failed to clean up CDN file:', {
      error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      fileId,
      timestamp: new Date().toISOString(),
    });
  }
}
