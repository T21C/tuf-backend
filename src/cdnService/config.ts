import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

if (!process.env.USER_CDN_ROOT || !process.env.CDN_URL) {
    throw new Error('USER_CDN_ROOT and CDN_URL must be set');
}

export const CDN_CONFIG = {
    user_root: process.env.USER_CDN_ROOT,
    maxFileSize: 1000 * 1024 * 1024, // 1GB
    maxImageSize: 10 * 1024 * 1024, // 10MB
    cacheControl: 'public, max-age=31536000', // 1 year
    baseUrl: process.env.CDN_URL,
    port: process.env.CDN_URL.split(':')[2]
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
        formats: ['jpg', 'jpeg', 'png', 'webp'] as const,
        maxSize: 5 * 1024 * 1024 // 5MB
    },
    BANNER: {
        name: 'banner',
        sizes: {
            original: { width: 1920, height: 1080 },
            large: { width: 1280, height: 720 },
            medium: { width: 854, height: 480 },
            small: { width: 640, height: 360 }
        },
        formats: ['jpg', 'jpeg', 'png', 'webp'] as const,
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
        formats: ['jpg', 'jpeg', 'png', 'webp'] as const,
        maxSize: 2 * 1024 * 1024 // 2MB
    }
} as const;

export const MIME_TYPES = {
    'PROFILE': 'image/png',
    'BANNER': 'image/png',
    'THUMBNAIL': 'image/png',
    'LEVELZIP': 'application/zip',
    'GENERAL': 'application/octet-stream'
} as const;

export type ImageType = keyof typeof IMAGE_TYPES;
export type ImageSize = keyof typeof IMAGE_TYPES.PROFILE.sizes;