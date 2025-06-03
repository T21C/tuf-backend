import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import { CDN_CONFIG, IMAGE_TYPES, ImageType } from '../config.js';
import { logger } from '../../services/LoggerService.js';

// Utility function to safely delete files and directories
export function cleanupFiles(...paths: (string | undefined | null)[]): void {
    for (const path of paths) {
        if (!path) continue;

        try {
            if (fs.existsSync(path)) {
                const stats = fs.statSync(path);
                if (stats.isDirectory()) {
                    fs.rmSync(path, { recursive: true, force: true });
                } else {
                    fs.unlinkSync(path);
                }
            }
        } catch (error) {
            logger.error(`Failed to cleanup path ${path}:`, error);
        }
    }
}

// Configure storage for regular files
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(CDN_CONFIG.root, 'temp');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueId = uuidv4();
        const ext = path.extname(file.originalname);
        cb(null, `${uniqueId}${ext}`);
    }
});

// Configure storage for images
const imageStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const imageType = (req.params.type || '').toUpperCase() as ImageType;
        if (!IMAGE_TYPES[imageType]) {
            throw new Error('Invalid image type');
        }
        const uploadDir = path.join(CDN_CONFIG.root, 'images', IMAGE_TYPES[imageType].name);
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueId = uuidv4();
        const ext = path.extname(file.originalname);
        cb(null, `${uniqueId}${ext}`);
    }
});

export const upload = multer({
    storage,
    limits: {
        fileSize: CDN_CONFIG.maxFileSize
    }
}).single('file');

export const imageUpload = multer({
    storage: imageStorage,
    limits: {
        fileSize: CDN_CONFIG.maxImageSize
    },
    fileFilter: (req, file, cb) => {
        const imageType = (req.params.type || '').toUpperCase() as ImageType;
        if (!IMAGE_TYPES[imageType]) {
            return cb(new Error('Invalid image type'));
        }
        
        const ext = path.extname(file.originalname).toLowerCase().slice(1) as typeof IMAGE_TYPES[ImageType]['formats'][number];
        if (!IMAGE_TYPES[imageType].formats.includes(ext)) {
            return cb(new Error(`Invalid file type. Allowed types: ${IMAGE_TYPES[imageType].formats.join(', ')}`));
        }
        
        cb(null, true);
    }
}).single('image'); 