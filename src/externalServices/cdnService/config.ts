import dotenv from 'dotenv';
import path from 'path';
dotenv.config();

/** Cache-Control for versioned CDN assets (Spaces objects + long-lived static responses). */
export const CDN_IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable' as const;

if (!process.env.CDN_URL) {
    throw new Error('CDN_URL must be set');
}

if (process.env.NODE_ENV === 'production' && !process.env.CDN_TEMP_ROOT?.trim()) {
    throw new Error('CDN_TEMP_ROOT must be set in production');
}

if (!process.env.JOB_PROGRESS_INGEST_SECRET) {
    throw new Error('JOB_PROGRESS_INGEST_SECRET must be set');
}

const localCdnUrl = process.env.LOCAL_CDN_URL || 'http://localhost:3001';
/** Single on-disk root for CDN temp, multer, zip scratch, image staging, and tuf-cdn-spaces (via config). Set `CDN_TEMP_ROOT`. */
const localRoot = path.resolve(
    process.env.CDN_TEMP_ROOT?.trim() || path.join(process.cwd(), 'cache', 'cdn-local-fallback')
);

export const CDN_CONFIG = {
    localRoot,
    pack_root: process.env.PACK_CDN_ROOT || path.join(localRoot, 'packs'),
    maxFileSize: 4000 * 1024 * 1024, // 4GB
    maxImageSize: 10 * 1024 * 1024, // 10MB
    cacheControl: CDN_IMMUTABLE_CACHE_CONTROL,
    baseUrl: process.env.CDN_URL,
    port: process.env.CDN_PORT || localCdnUrl.split(':')[2]
} as const;
// Image type configurations
export const IMAGE_TYPES = {
    PROFILE: {
        name: 'profile',
        sizes: {
            original: { width: 1024, height: 1024 },
            large: { width: 512, height: 512 },
            medium: { width: 256, height: 256 },
            small: { width: 128, height: 128 },
            thumbnail: { width: 64, height: 64 }
        },
        formats: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'] as const,
        maxSize: 10 * 1024 * 1024 // 5MB
    },
    BANNER: {
        name: 'banner',
        sizes: {
            original: { width: 1920, height: 1080 },
            large: { width: 1280, height: 720 },
            medium: { width: 854, height: 480 },
            small: { width: 640, height: 360 }
        },
        formats: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'] as const,
        maxSize: 10 * 1024 * 1024 // 10MB
    },
    THUMBNAIL: {
        name: 'thumbnail',
        sizes: {
            original: { width: 800, height: 600 },
            large: { width: 400, height: 300 },
            medium: { width: 200, height: 150 },
            small: { width: 100, height: 75 }
        },
        formats: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'] as const,
        maxSize: 5 * 1024 * 1024 // 5MB
    },
    CURATION_ICON: {
        name: 'curation_icon',
        sizes: {
            original: { width: 256, height: 256 },
            medium: { width: 128, height: 128 },
            small: { width: 64, height: 64 }
        },
        formats: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'] as const,
        maxSize: 5 * 1024 * 1024 // 5MB
    },
    DIFFICULTY_ICON: {
        name: 'difficulty_icon',
        sizes: {
            original: { width: 256, height: 256 },
            medium: { width: 128, height: 128 },
            small: { width: 64, height: 64 }
        },
        formats: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'] as const,
        maxSize: 5 * 1024 * 1024 // 5MB
    },
    LEVEL_THUMBNAIL: {
        name: 'level_thumbnail',
        sizes: {
            original: { width: 1200, height: 800 },
            large: { width: 600, height: 400 },
            medium: { width: 300, height: 200 },
            small: { width: 150, height: 100 },
            thumbnail: { width: 75, height: 50 }
        },
        formats: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'] as const,
        maxSize: 10 * 1024 * 1024 // 10MB
    },
    PACK_ICON: {
        name: 'pack_icon',
        sizes: {
            original: { width: 256, height: 256 },
            medium: { width: 128, height: 128 },
            small: { width: 64, height: 64 }
        },
        formats: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'] as const,
        maxSize: 5 * 1024 * 1024 // 5MB
    },
    TAG_ICON: {
        name: 'tag_icon',
        sizes: {
            original: { width: 256, height: 256 },
            medium: { width: 128, height: 128 },
            small: { width: 64, height: 64 }
        },
        formats: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'] as const,
        maxSize: 5 * 1024 * 1024 // 5MB
    },
    EVIDENCE: {
        name: 'evidence',
        sizes: {
            original: { width: 1920, height: 1080 },
            large: { width: 1280, height: 720 },
            medium: { width: 854, height: 480 },
            small: { width: 640, height: 360 }
        },
        formats: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'] as const,
        maxSize: 15 * 1024 * 1024 // 15MB
    }
} as const;

export const MIME_TYPES = {
    'PROFILE': 'image/png',
    'BANNER': 'image/png',
    'THUMBNAIL': 'image/png',
    'CURATION_ICON': 'image/png',
    'DIFFICULTY_ICON': 'image/png',
    'LEVEL_THUMBNAIL': 'image/png',
    'PACK_ICON': 'image/png',
    'TAG_ICON': 'image/png',
    'LEVELZIP': 'application/zip',
    'EVIDENCE': 'image/png',
    'GENERAL': 'application/octet-stream'
} as const;

export type ImageType = keyof typeof IMAGE_TYPES;
export type ImageSize = keyof typeof IMAGE_TYPES.PROFILE.sizes;
