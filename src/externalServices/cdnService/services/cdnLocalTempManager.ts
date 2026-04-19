import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import { CDN_CONFIG, IMAGE_TYPES, ImageType } from '../config.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { withUtf8Filenames, decodeMultipartFilename } from '@/misc/utils/multipartFilename.js';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Local CDN scratch only: multer upload targets and safe deletes under {@link getLocalRoot}.
 * No Spaces / S3 — use `spacesStorage` (spacesStorage.ts) for permanent objects.
 */
export class CdnLocalTempManager {
    private static instance: CdnLocalTempManager;
    private readonly localRoot: string;

    private constructor() {
        this.localRoot = path.resolve(CDN_CONFIG.localRoot);
        if (!fs.existsSync(this.localRoot)) {
            fs.mkdirSync(this.localRoot, { recursive: true });
        }
    }

    public static getInstance(): CdnLocalTempManager {
        if (!CdnLocalTempManager.instance) {
            CdnLocalTempManager.instance = new CdnLocalTempManager();
        }
        return CdnLocalTempManager.instance;
    }

    public getLocalRoot(): string {
        return this.localRoot;
    }

    /**
     * Create `absPath` only if it lies under {@link getLocalRoot}; throws otherwise.
     */
    public ensureDirUnderLocalRoot(absPath: string): void {
        const resolved = path.resolve(absPath);
        if (!this.isPathUnderLocalRoot(resolved)) {
            throw new Error(`Refusing to create directory outside local CDN root: ${resolved}`);
        }
        if (!fs.existsSync(resolved)) {
            fs.mkdirSync(resolved, { recursive: true });
        }
    }

    private isPathUnderLocalRoot(absolutePath: string): boolean {
        const root = path.resolve(this.localRoot);
        const candidate = path.resolve(absolutePath);
        const rootNorm = root.replace(/\\/g, '/');
        const candNorm = candidate.replace(/\\/g, '/');
        const prefix = rootNorm.endsWith('/') ? rootNorm : `${rootNorm}/`;
        return candNorm === rootNorm || candNorm.startsWith(prefix);
    }

    /**
     * Boot-time sweep of the multer upload directory (`<localRoot>/temp`).
     *
     * Every successful or failing upload deletes its own `req.file.path` in the route
     * handler, so while the process is alive there are no leaks. The only way temp
     * files survive is when Node dies between `multer.diskStorage` writing the file
     * and the route's `cleanupFiles` running (SIGKILL, OOM, hard crash, deploy mid-upload).
     *
     * One sweep on boot is therefore sufficient — there is no need for a periodic
     * timer. The upload `<uuid>.zip` files cannot be moved into a {@link withWorkspace}
     * workspace because multer writes them before any route handler runs, so they
     * can't participate in the workspace boot-sweep.
     *
     * Idempotent and best-effort: failures are logged but do not throw.
     */
    public async sweepUploadTempOnBoot(): Promise<void> {
        const tempDir = path.join(this.localRoot, 'temp');
        try {
            if (!fs.existsSync(tempDir)) return;
            const entries = await fs.promises.readdir(tempDir, { withFileTypes: true });
            let removed = 0;
            for (const entry of entries) {
                const target = path.join(tempDir, entry.name);
                try {
                    await fs.promises.rm(target, { recursive: true, force: true });
                    removed++;
                } catch (err) {
                    logger.warn('cdn-temp/temp boot sweep: failed to remove entry', {
                        target,
                        error: err instanceof Error ? err.message : String(err)
                    });
                }
            }
            if (removed > 0) {
                logger.info('cdn-temp/temp boot sweep removed stale upload entries', {
                    tempDir,
                    removed
                });
            } else {
                logger.debug('cdn-temp/temp boot sweep complete (no stale entries)', { tempDir });
            }
        } catch (error) {
            logger.warn('cdn-temp/temp boot sweep failed', {
                tempDir,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    public cleanupFiles(...paths: (string | undefined | null)[]): void {
        for (const rawPath of paths) {
            if (!rawPath) {
                continue;
            }
            const normalizedPath = rawPath.replace(/\\/g, '/');

            try {
                if (!normalizedPath || normalizedPath === '/' || normalizedPath === '') {
                    logger.error('Invalid path provided for cleanup:', normalizedPath);
                    continue;
                }

                const absolutePath = path.resolve(normalizedPath);
                const normalizedAbsolutePath = absolutePath.replace(/\\/g, '/');

                if (!this.isPathUnderLocalRoot(absolutePath)) {
                    logger.error('Attempted to delete file outside of local CDN root:', {
                        path: normalizedAbsolutePath,
                        localRoot: this.localRoot
                    });
                    continue;
                }

                logger.debug(`Deleting file/directory: ${normalizedAbsolutePath}`);
                if (fs.existsSync(normalizedAbsolutePath)) {
                    const stats = fs.statSync(normalizedAbsolutePath);
                    if (stats.isDirectory()) {
                        if (normalizedAbsolutePath.includes('/images/')) {
                            try {
                                const contents = fs.readdirSync(normalizedAbsolutePath);
                                logger.debug(`Deleting image directory with ${contents.length} files:`, {
                                    directory: normalizedAbsolutePath,
                                    files: contents
                                });
                            } catch (readdirError) {
                                logger.warn('Could not read directory contents before deletion:', readdirError);
                            }
                        }
                        fs.rmSync(normalizedAbsolutePath, { recursive: true, force: true });
                        logger.debug(`Successfully deleted directory: ${normalizedAbsolutePath}`);
                    } else {
                        fs.unlinkSync(normalizedAbsolutePath);
                        logger.debug(`Successfully deleted file: ${normalizedAbsolutePath}`);
                    }
                } else {
                    logger.debug(`Cleanup skipped (path already gone): ${normalizedAbsolutePath}`);
                }
            } catch (error) {
                logger.error(`Failed to cleanup path ${normalizedPath}:`, {
                    error: error instanceof Error ? error.message : String(error),
                    path: normalizedPath
                });
            }
        }
    }

    private storage = multer.diskStorage({
        destination: (req, file, cb) => {
            try {
                const uploadDir = path.join(this.getLocalRoot(), 'temp');
                this.ensureDirUnderLocalRoot(uploadDir);
                cb(null, uploadDir);
            } catch (error) {
                cb(error as Error, '');
            }
        },
        filename: (req, file, cb) => {
            const uniqueId = uuidv4();
            const ext = path.extname(decodeMultipartFilename(file.originalname));
            cb(null, `${uniqueId}${ext}`);
        }
    });

    private imageStorage = multer.diskStorage({
        destination: (req, file, cb) => {
            try {
                const imageType = (req.params.type || '').toUpperCase() as ImageType;
                if (!IMAGE_TYPES[imageType]) {
                    throw new Error('Invalid image type');
                }
                const uploadDir = path.join(this.getLocalRoot(), 'images', IMAGE_TYPES[imageType].name);
                this.ensureDirUnderLocalRoot(uploadDir);
                cb(null, uploadDir);
            } catch (error) {
                cb(error as Error, '');
            }
        },
        filename: (req, file, cb) => {
            const uniqueId = uuidv4();
            const ext = path.extname(decodeMultipartFilename(file.originalname));
            cb(null, `${uniqueId}${ext}`);
        }
    });

    // Wrapping with `withUtf8Filenames` rewrites `req.file.originalname` back to
    // valid UTF-8 NFC after multer finishes, fixing the mojibake introduced by
    // busboy's latin-1 default (see `multipartFilename.ts`).
    public upload = withUtf8Filenames(multer({
        storage: this.storage,
        limits: {
            fileSize: CDN_CONFIG.maxFileSize
        }
    }).single('file'));

    public imageUpload = withUtf8Filenames(multer({
        storage: this.imageStorage,
        limits: {
            fileSize: CDN_CONFIG.maxImageSize
        },
        fileFilter: (req, file, cb) => {
            const imageType = (req.params.type || '').toUpperCase() as ImageType;
            if (!IMAGE_TYPES[imageType]) {
                return cb(new Error('Invalid image type'));
            }

            const ext = path.extname(decodeMultipartFilename(file.originalname)).toLowerCase().slice(1) as typeof IMAGE_TYPES[ImageType]['formats'][number];
            if (!IMAGE_TYPES[imageType].formats.includes(ext)) {
                return cb(new Error(`Invalid file type. Allowed types: ${IMAGE_TYPES[imageType].formats.join(', ')}`));
            }

            cb(null, true);
        }
    }).single('image'));
}

export const cdnLocalTemp = CdnLocalTempManager.getInstance();
