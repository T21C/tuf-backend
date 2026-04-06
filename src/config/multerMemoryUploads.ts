import type { Request } from 'express';
import multer from 'multer';
import type { FileFilterCallback } from 'multer';

/**
 * MIME types for in-memory uploads that are processed by the CDN image pipeline.
 * Keep aligned with `IMAGE_TYPES[].formats` in `externalServices/cdnService/config.ts`
 * and `CDN_IMAGE_ACCEPT` on the client.
 */
export const CDN_IMAGE_MIME_TYPES: readonly string[] = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml',
];

export const cdnImageMimeFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: FileFilterCallback
): void => {
  if (CDN_IMAGE_MIME_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPEG, PNG, WebP, GIF, and SVG images are allowed.'));
  }
};

function createMemoryCdnImageMulter(fileSizeBytes: number) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: fileSizeBytes },
    fileFilter: cdnImageMimeFilter,
  });
}

/** Matches `CDN_CONFIG.maxImageSize` / typical admin evidence and profile uploads */
export const multerMemoryCdnImage10Mb = createMemoryCdnImageMulter(10 * 1024 * 1024);

/** Matches PACK_ICON / TAG_ICON / CURATION_ICON `maxSize` in IMAGE_TYPES */
export const multerMemoryCdnImage5Mb = createMemoryCdnImageMulter(5 * 1024 * 1024);
