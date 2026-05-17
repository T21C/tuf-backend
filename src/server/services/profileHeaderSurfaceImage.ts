import { SURFACE_STACK_KIND_IMAGE } from '@/misc/utils/profileHeaderSurfaceStyle.js';
import type { ProfileHeaderSurfaceStyle } from '@/misc/utils/profileHeaderSurfaceStyle.js';
import cdnService from '@/server/services/core/CdnService.js';
import { logger } from '@/server/services/core/LoggerService.js';

export function styleHasImageLayer(style: ProfileHeaderSurfaceStyle | null): boolean {
  return style !== null && style.stack.some((e) => e.kind === SURFACE_STACK_KIND_IMAGE);
}

/** When saved style has no image stack entry, clear DB columns and delete the CDN file. */
export async function reconcileOrphanProfileHeaderSurfaceImage(
  existingImageId: string | null | undefined,
  parsedStyle: ProfileHeaderSurfaceStyle | null,
): Promise<{ profileHeaderSurfaceImageId: null; profileHeaderSurfaceImageUrl: null } | null> {
  if (styleHasImageLayer(parsedStyle) || !existingImageId) {
    return null;
  }

  try {
    if (await cdnService.checkFileExists(existingImageId)) {
      await cdnService.deleteFile(existingImageId);
    }
  } catch (err) {
    logger.error('Failed to delete orphan profile header surface image from CDN:', err);
  }

  return {
    profileHeaderSurfaceImageId: null,
    profileHeaderSurfaceImageUrl: null,
  };
}
