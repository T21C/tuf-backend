import AWS from 'aws-sdk';
import { logger } from '@/server/services/LoggerService.js';
import { CDN_IMMUTABLE_CACHE_CONTROL } from '@/externalServices/cdnService/config.js';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4, validate as validateUuid } from 'uuid';

dotenv.config();

interface SpacesConfig {
    accessKeyId: string;
    secretAccessKey: string;
    endpoint: string;
    cdnEndpoint: string;
    region: string;
    bucket: string;
}

/** Cloudflare R2 (S3 API). */
interface R2Config {
    accessKeyId: string;
    secretAccessKey: string;
    endpoint: string;
    bucket: string;
}

function envFlagTrue(raw: string | undefined): boolean {
    const v = String(raw ?? '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
}

function normalizeCdnBase(url: string): string {
    return url.trim().replace(/\/+$/, '');
}

// --- DigitalOcean Spaces env (remove after R2 cutover) ---
function loadDigitalOceanConfig(): SpacesConfig | null {
    const accessKeyId = process.env.DIGITAL_OCEAN_KEY;
    const secretAccessKey = process.env.DIGITAL_OCEAN_SECRET;
    const region = process.env.DIGITAL_OCEAN_REGION || 'sgp1';
    const bucket = process.env.DIGITAL_OCEAN_BUCKET;
    const cdnEndpoint = process.env.DIGITAL_OCEAN_CDN_ENDPOINT;

    if (!accessKeyId || !secretAccessKey || !bucket || !cdnEndpoint) {
        return null;
    }

    return {
        accessKeyId,
        secretAccessKey,
        endpoint: `https://${region}.digitaloceanspaces.com`,
        cdnEndpoint,
        region,
        bucket
    };
}

function loadR2Config(): R2Config | null {
    const accessKeyId = process.env.CF_ACCESS_KEY;
    const secretAccessKey = process.env.CF_SECRET_KEY;
    const bucket = process.env.CF_BUCKET;
    const endpointFromEnv = process.env.CF_R2_S3_ENDPOINT?.trim();
    const accountId = process.env.CF_ACCOUNT_ID?.trim();

    let endpoint: string | undefined;
    if (endpointFromEnv) {
        endpoint = endpointFromEnv.replace(/\/+$/, '');
    } else if (accountId) {
        endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
    }

    if (!accessKeyId || !secretAccessKey || !bucket || !endpoint) {
        return null;
    }

    return {
        accessKeyId,
        secretAccessKey,
        endpoint,
        bucket
    };
}

function createDoS3Client(cfg: SpacesConfig): AWS.S3 {
    return new AWS.S3({
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
        endpoint: cfg.endpoint,
        region: cfg.region,
        s3ForcePathStyle: true,
        signatureVersion: 'v4'
    });
}

function createR2S3Client(cfg: R2Config): AWS.S3 {
    return new AWS.S3({
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
        endpoint: cfg.endpoint,
        region: 'auto',
        s3ForcePathStyle: true,
        signatureVersion: 'v4'
    });
}

interface UploadResult {
    key: string;
    url: string;
    size: number;
    etag: string;
}

interface SpacesFile {
    key: string;
    size: number;
    lastModified: Date;
    etag: string;
    url: string;
}

/**
 * Object storage facade: DigitalOcean Spaces and/or Cloudflare R2 (S3 API).
 * When STORAGE_DUAL_WRITE=true, writes go to both; reads use DO until R2-only mode.
 */
export class CdnSpacesStorage {
    private static instance: CdnSpacesStorage;

    /** Head/get/list/download — DO while dual-write; R2 when R2-only. */
    private s3Read: AWS.S3;
    private readBucket: string;
    private publicCdnBase: string;
    private dualWrite: boolean;

    // --- DigitalOcean (remove after R2 cutover) ---
    private s3Do: AWS.S3 | null = null;
    private doBucket: string | null = null;

    // --- R2 ---
    private s3R2: AWS.S3 | null = null;
    private r2Bucket: string | null = null;

    constructor() {
        const dualWrite = envFlagTrue(process.env.STORAGE_DUAL_WRITE);
        const doCfg = loadDigitalOceanConfig();
        const r2Cfg = loadR2Config();
        const publicOverride = process.env.STORAGE_PUBLIC_CDN_BASE?.trim();

        if (dualWrite) {
            if (!doCfg || !r2Cfg) {
                throw new Error(
                    'STORAGE_DUAL_WRITE requires both DigitalOcean (DIGITAL_OCEAN_KEY, DIGITAL_OCEAN_SECRET, DIGITAL_OCEAN_BUCKET, DIGITAL_OCEAN_CDN_ENDPOINT) and R2 (CF_ACCESS_KEY, CF_SECRET_KEY, CF_BUCKET, CF_ACCOUNT_ID or CF_R2_S3_ENDPOINT)'
                );
            }
            this.dualWrite = true;
            this.s3Do = createDoS3Client(doCfg);
            this.doBucket = doCfg.bucket;
            this.s3R2 = createR2S3Client(r2Cfg);
            this.r2Bucket = r2Cfg.bucket;
            this.s3Read = this.s3Do;
            this.readBucket = doCfg.bucket;
            this.publicCdnBase = normalizeCdnBase(publicOverride || doCfg.cdnEndpoint);

            logger.info('Object storage: dual-write DO + R2', {
                doEndpoint: doCfg.endpoint,
                doBucket: doCfg.bucket,
                r2Endpoint: r2Cfg.endpoint,
                r2Bucket: r2Cfg.bucket,
                publicCdnBase: this.publicCdnBase
            });
            return;
        }

        if (doCfg) {
            this.dualWrite = false;
            this.s3Do = createDoS3Client(doCfg);
            this.s3Read = this.s3Do;
            this.readBucket = doCfg.bucket;
            this.publicCdnBase = normalizeCdnBase(publicOverride || doCfg.cdnEndpoint);
            logger.info('DigitalOcean Spaces S3 client initialized', {
                endpoint: doCfg.endpoint,
                region: doCfg.region,
                bucket: doCfg.bucket
            });
            return;
        }

        if (r2Cfg) {
            if (!publicOverride) {
                throw new Error(
                    'R2-only mode requires STORAGE_PUBLIC_CDN_BASE (and CF_ACCESS_KEY, CF_SECRET_KEY, CF_BUCKET, CF_ACCOUNT_ID or CF_R2_S3_ENDPOINT)'
                );
            }
            this.dualWrite = false;
            this.s3R2 = createR2S3Client(r2Cfg);
            this.s3Read = this.s3R2;
            this.readBucket = r2Cfg.bucket;
            this.publicCdnBase = normalizeCdnBase(publicOverride);

            logger.info('Object storage: R2 only', {
                endpoint: r2Cfg.endpoint,
                bucket: r2Cfg.bucket,
                publicCdnBase: this.publicCdnBase
            });
            return;
        }

        throw new Error(
            'Missing object storage config: set DigitalOcean (DIGITAL_OCEAN_KEY, DIGITAL_OCEAN_SECRET, DIGITAL_OCEAN_BUCKET, DIGITAL_OCEAN_CDN_ENDPOINT) and/or R2 with STORAGE_DUAL_WRITE=true, or R2-only with STORAGE_PUBLIC_CDN_BASE'
        );
    }

    public static getInstance(): CdnSpacesStorage {
        if (!CdnSpacesStorage.instance) {
            CdnSpacesStorage.instance = new CdnSpacesStorage();
        }
        return CdnSpacesStorage.instance;
    }

    private async putObjectDo(
        params: Omit<AWS.S3.PutObjectRequest, 'Bucket'>
    ): Promise<AWS.S3.ManagedUpload.SendData> {
        if (!this.s3Do || !this.doBucket) {
            throw new Error('DigitalOcean S3 client not configured');
        }
        return this.s3Do.upload({ ...params, Bucket: this.doBucket }).promise();
    }

    /** R2: no ACL (not supported like DO). */
    private async putObjectR2(
        params: Omit<AWS.S3.PutObjectRequest, 'Bucket' | 'ACL'>
    ): Promise<AWS.S3.ManagedUpload.SendData> {
        if (!this.s3R2 || !this.r2Bucket) {
            throw new Error('R2 S3 client not configured');
        }
        return this.s3R2.upload({ ...params, Bucket: this.r2Bucket }).promise();
    }

    private async putObjectPrimary(
        params: Omit<AWS.S3.PutObjectRequest, 'Bucket'>
    ): Promise<AWS.S3.ManagedUpload.SendData> {
        return this.s3Read.upload({ ...params, Bucket: this.readBucket }).promise();
    }

    /**
     * Upload a file to object storage (dual-write to DO + R2 when enabled).
     */
    public async uploadFile(
        filePath: string,
        key: string,
        contentType?: string,
        metadata?: Record<string, string>,
        cacheControl: string = CDN_IMMUTABLE_CACHE_CONTROL
    ): Promise<UploadResult> {
        try {
            const fileStats = await fs.promises.stat(filePath);

            logger.debug('file upload stats', fileStats);

            const resolvedContentType = contentType || this.getContentType(key);
            const meta = metadata || {};

            logger.debug('Uploading file (streaming)', {
                key,
                size: fileStats.size,
                contentType: resolvedContentType,
                dualWrite: this.dualWrite,
                readBucket: this.readBucket
            });

            let result: AWS.S3.ManagedUpload.SendData;

            if (this.dualWrite && this.s3Do && this.s3R2) {
                const streamDo = fs.createReadStream(filePath);
                const streamR2 = fs.createReadStream(filePath);
                const [doResult] = await Promise.all([
                    this.putObjectDo({
                        Key: key,
                        Body: streamDo,
                        ContentType: resolvedContentType,
                        CacheControl: cacheControl,
                        Metadata: meta,
                        ACL: 'private'
                    }),
                    this.putObjectR2({
                        Key: key,
                        Body: streamR2,
                        ContentType: resolvedContentType,
                        CacheControl: cacheControl,
                        Metadata: meta
                    })
                ]);
                result = doResult;
            } else {
                const fileStream = fs.createReadStream(filePath);
                const uploadParams: Omit<AWS.S3.PutObjectRequest, 'Bucket'> = {
                    Key: key,
                    Body: fileStream,
                    ContentType: resolvedContentType,
                    CacheControl: cacheControl,
                    Metadata: meta
                };
                if (this.s3Do !== null && this.s3Read === this.s3Do) {
                    uploadParams.ACL = 'private';
                }
                result = await this.putObjectPrimary(uploadParams);
            }

            logger.debug('File uploaded successfully', {
                key,
                size: fileStats.size,
                etag: result.ETag,
                location: result.Location
            });

            return {
                key: result.Key,
                url: result.Location,
                size: fileStats.size,
                etag: result.ETag || ''
            };
        } catch (error) {
            logger.error('Failed to upload file', {
                error: error instanceof Error ? error.message : String(error),
                key,
                filePath
            });
            throw error;
        }
    }

    /**
     * Upload a buffer directly to object storage (dual-write when enabled).
     */
    public async uploadBuffer(
        buffer: Buffer,
        key: string,
        contentType?: string,
        metadata?: Record<string, string>,
        cacheControl: string = CDN_IMMUTABLE_CACHE_CONTROL
    ): Promise<UploadResult> {
        try {
            const resolvedContentType = contentType || this.getContentType(key);
            const meta = metadata || {};

            logger.debug('Uploading buffer', {
                key,
                size: buffer.length,
                contentType: resolvedContentType,
                dualWrite: this.dualWrite
            });

            let result: AWS.S3.ManagedUpload.SendData;

            if (this.dualWrite && this.s3Do && this.s3R2) {
                const [doResult] = await Promise.all([
                    this.putObjectDo({
                        Key: key,
                        Body: buffer,
                        ContentType: resolvedContentType,
                        CacheControl: cacheControl,
                        Metadata: meta,
                        ACL: 'private'
                    }),
                    this.putObjectR2({
                        Key: key,
                        Body: buffer,
                        ContentType: resolvedContentType,
                        CacheControl: cacheControl,
                        Metadata: meta
                    })
                ]);
                result = doResult;
            } else {
                const uploadParams: Omit<AWS.S3.PutObjectRequest, 'Bucket'> = {
                    Key: key,
                    Body: buffer,
                    ContentType: resolvedContentType,
                    CacheControl: cacheControl,
                    Metadata: meta
                };
                if (this.s3Do !== null && this.s3Read === this.s3Do) {
                    uploadParams.ACL = 'private';
                }
                result = await this.putObjectPrimary(uploadParams);
            }

            logger.debug('Buffer uploaded successfully', {
                key,
                size: buffer.length,
                etag: result.ETag,
                location: result.Location
            });

            return {
                key: result.Key,
                url: result.Location,
                size: buffer.length,
                etag: result.ETag || ''
            };
        } catch (error) {
            logger.error('Failed to upload buffer', {
                error: error instanceof Error ? error.message : String(error),
                key,
                size: buffer.length
            });
            throw error;
        }
    }

    /**
     * Download a file from DigitalOcean Spaces
     */
    public async downloadFile(key: string, localPath?: string): Promise<Buffer> {
        try {
            const downloadParams: AWS.S3.GetObjectRequest = {
                Bucket: this.readBucket,
                Key: key
            };

            logger.debug('Downloading file from Spaces', { key, bucket: this.readBucket });

            const result = await this.s3Read.getObject(downloadParams).promise();

            if (!result.Body) {
                throw new Error('No file content received from Spaces');
            }

            const buffer = result.Body as Buffer;

            // Save to local path if provided
            if (localPath) {
                await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
                await fs.promises.writeFile(localPath, buffer);
                logger.debug('File downloaded and saved locally', { key, localPath, size: buffer.length });
            } else {
                logger.debug('File downloaded from Spaces', { key, size: buffer.length });
            }

            return buffer;
        } catch (error) {
            logger.error('Failed to download file from Spaces', {
                error: error instanceof Error ? error.message : String(error),
                key
            });
            throw error;
        }
    }

    /**
     * Stream a file from Spaces to a local path without buffering the whole object in memory.
     */
    public async downloadFileToPathStreaming(key: string, localPath: string): Promise<void> {
        await fs.promises.mkdir(path.dirname(localPath), { recursive: true });

        const params: AWS.S3.GetObjectRequest = {
            Bucket: this.readBucket,
            Key: key
        };

        logger.debug('Downloading file from Spaces (streaming)', { key, localPath, bucket: this.readBucket });

        const stream = this.s3Read.getObject(params).createReadStream();
        const writeStream = fs.createWriteStream(localPath);

        return new Promise<void>((resolve, reject) => {
            const cleanupOnError = async (error: Error) => {
                stream.destroy();
                writeStream.destroy();
                try {
                    if (fs.existsSync(localPath)) {
                        await fs.promises.unlink(localPath);
                    }
                } catch (cleanupError) {
                    logger.warn('Failed to cleanup partial file after stream error', {
                        localPath,
                        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
                    });
                }
                reject(error);
            };

            stream.pipe(writeStream);
            writeStream.on('finish', () => {
                logger.debug('File downloaded from Spaces (streaming)', { key, localPath });
                resolve();
            });
            writeStream.on('error', cleanupOnError);
            stream.on('error', cleanupOnError);
        });
    }

    /**
     * Delete a file from DigitalOcean Spaces
     */
    public async deleteFile(key: string): Promise<void> {
        try {
            const normalizedKey = this.assertSafeDeleteKey(key);
            const deleteParams: AWS.S3.DeleteObjectRequest = {
                Bucket: this.readBucket,
                Key: normalizedKey
            };

            logger.debug('Deleting file from object storage', { key: normalizedKey, bucket: this.readBucket });

            await this.s3Read.deleteObject(deleteParams).promise();

            if (this.dualWrite && this.s3R2 && this.r2Bucket) {
                await this.s3R2
                    .deleteObject({ Bucket: this.r2Bucket, Key: normalizedKey })
                    .promise();
            }

            logger.debug('File deleted successfully', { key: normalizedKey });
        } catch (error) {
            logger.error('Failed to delete file from Spaces', {
                error: error instanceof Error ? error.message : String(error),
                key
            });
            throw error;
        }
    }

    /**
     * Delete multiple files from DigitalOcean Spaces
     */
    public async deleteFiles(keys: string[]): Promise<void> {
        if (keys.length === 0) return;

        try {
            const normalizedKeys = keys.map((key) => this.assertSafeDeleteKey(key));
            const deleteParams: AWS.S3.DeleteObjectsRequest = {
                Bucket: this.readBucket,
                Delete: {
                    Objects: normalizedKeys.map(key => ({ Key: key }))
                }
            };

            logger.debug('Deleting multiple files from Spaces', {
                count: normalizedKeys.length,
                keys: normalizedKeys.slice(0, 5), // Log first 5 keys
                bucket: this.readBucket
            });

            const result = await this.s3Read.deleteObjects(deleteParams).promise();

            if (result.Errors && result.Errors.length > 0) {
                logger.warn('Some files failed to delete from primary bucket', {
                    errors: result.Errors,
                    deletedCount: result.Deleted?.length || 0
                });
            }

            if (this.dualWrite && this.s3R2 && this.r2Bucket) {
                const r2DeleteParams: AWS.S3.DeleteObjectsRequest = {
                    Bucket: this.r2Bucket,
                    Delete: {
                        Objects: normalizedKeys.map((k) => ({ Key: k }))
                    }
                };
                const r2Result = await this.s3R2.deleteObjects(r2DeleteParams).promise();
                if (r2Result.Errors && r2Result.Errors.length > 0) {
                    logger.warn('Some files failed to delete from R2', {
                        errors: r2Result.Errors,
                        deletedCount: r2Result.Deleted?.length || 0
                    });
                }
            }

            logger.debug('Files deleted from object storage', {
                deletedCount: result.Deleted?.length || 0,
                errorCount: result.Errors?.length || 0
            });
        } catch (error) {
            logger.error('Failed to delete files from Spaces', {
                error: error instanceof Error ? error.message : String(error),
                count: keys.length
            });
            throw error;
        }
    }

    private assertSafeDeleteKey(key: string): string {
        const normalizedKey = String(key || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
        const protectedRootPrefixes = new Set(['levels', 'zips', 'images', 'songs', 'files', 'temp']);

        if (!normalizedKey) {
            throw new Error('Unsafe Spaces delete key rejected: empty key');
        }

        if (normalizedKey.endsWith('/')) {
            throw new Error(`Unsafe Spaces delete key rejected: directory-like key "${normalizedKey}"`);
        }

        const segments = normalizedKey.split('/');
        if (segments.some(segment => segment.length === 0)) {
            throw new Error(`Unsafe Spaces delete key rejected: malformed key "${normalizedKey}"`);
        }

        if (segments.length === 1 && protectedRootPrefixes.has(segments[0])) {
            throw new Error(`Unsafe Spaces delete key rejected: broad root key "${normalizedKey}"`);
        }

        if (segments.length === 2 && protectedRootPrefixes.has(segments[0])) {
            throw new Error(`Unsafe Spaces delete key rejected: broad prefix key "${normalizedKey}"`);
        }

        return normalizedKey;
    }

    /**
     * List files in a directory/prefix
     */
    public async listFiles(prefix: string, maxKeys = 1000): Promise<SpacesFile[]> {
        try {
            const listParams: AWS.S3.ListObjectsV2Request = {
                Bucket: this.readBucket,
                Prefix: prefix,
                MaxKeys: maxKeys
            };

            logger.debug('Listing files in Spaces', { prefix, maxKeys, bucket: this.readBucket });

            const result = await this.s3Read.listObjectsV2(listParams).promise();

            const files: SpacesFile[] = (result.Contents || []).map(obj => ({
                key: obj.Key || '',
                size: obj.Size || 0,
                lastModified: obj.LastModified || new Date(),
                etag: obj.ETag || '',
                url: this.getFileUrl(obj.Key || '')
            }));

            logger.debug('Files listed from Spaces', {
                prefix,
                count: files.length,
                totalSize: files.reduce((sum, file) => sum + file.size, 0)
            });

            return files;
        } catch (error) {
            logger.error('Failed to list files from Spaces', {
                error: error instanceof Error ? error.message : String(error),
                prefix
            });
            throw error;
        }
    }

    /**
     * Check if a file exists in Spaces
     */
    public async fileExists(key: string): Promise<boolean> {
        try {
            const headParams: AWS.S3.HeadObjectRequest = {
                Bucket: this.readBucket,
                Key: key
            };

            await this.s3Read.headObject(headParams).promise();
            return true;
        } catch (error) {
            if ((error as any).statusCode === 404) {
                return false;
            }
            logger.error('Error checking file existence in Spaces', {
                error: error instanceof Error ? error.message : String(error),
                key
            });
            throw error;
        }
    }

    /**
     * Get file metadata from Spaces
     */
    public async getFileMetadata(key: string): Promise<AWS.S3.HeadObjectOutput | null> {
        try {
            const headParams: AWS.S3.HeadObjectRequest = {
                Bucket: this.readBucket,
                Key: key
            };

            const result = await this.s3Read.headObject(headParams).promise();
            return result;
        } catch (error) {
            if ((error as any).statusCode === 404) {
                return null;
            }
            logger.error('Error getting file metadata from Spaces', {
                error: error instanceof Error ? error.message : String(error),
                key
            });
            throw error;
        }
    }

    /**
     * Get a readable stream for a file from Spaces
     */
    public async getFileStream(key: string): Promise<NodeJS.ReadableStream> {
        try {
            const params: AWS.S3.GetObjectRequest = {
                Bucket: this.readBucket,
                Key: key
            };

            const response = await this.s3Read.getObject(params).promise();

            if (!response.Body) {
                throw new Error('No body in response');
            }

            // Convert the Body to a readable stream
            if (response.Body instanceof Buffer) {
                const { Readable } = await import('stream');
                return Readable.from(response.Body);
            } else if (typeof response.Body === 'string') {
                const { Readable } = await import('stream');
                return Readable.from(Buffer.from(response.Body));
            } else {
                // If it's already a stream, return it
                return response.Body as NodeJS.ReadableStream;
            }
        } catch (error) {
            logger.error('Failed to get file stream from Spaces', {
                error: error instanceof Error ? error.message : String(error),
                key
            });
            throw error;
        }
    }

    /**
     * Get a readable stream with range support for partial content
     */
    public async getFileStreamWithRange(key: string, start: number, end: number): Promise<NodeJS.ReadableStream> {
        try {
            const params: AWS.S3.GetObjectRequest = {
                Bucket: this.readBucket,
                Key: key,
                Range: `bytes=${start}-${end}`
            };

            const response = await this.s3Read.getObject(params).promise();

            if (!response.Body) {
                throw new Error('No body in response');
            }

            // Convert the Body to a readable stream
            if (response.Body instanceof Buffer) {
                const { Readable } = await import('stream');
                return Readable.from(response.Body);
            } else if (typeof response.Body === 'string') {
                const { Readable } = await import('stream');
                return Readable.from(Buffer.from(response.Body));
            } else {
                // If it's already a stream, return it
                return response.Body as NodeJS.ReadableStream;
            }
        } catch (error) {
            logger.error('Failed to get file stream with range from Spaces', {
                error: error instanceof Error ? error.message : String(error),
                key,
                start,
                end
            });
            throw error;
        }
    }

    /**
     * Get a public CDN URL for a file (bucket is public, no signing needed)
     * @param key - The file key
     */
    public async getPresignedUrl(key: string): Promise<string> {
        // Since the bucket is public, we just return the CDN URL directly
        // This enables proper CDN caching without query string parameters
        const url = this.getFileUrl(key);
        logger.debug('Generated CDN URL for Spaces file', { key });
        return url;
    }

    /**
     * Get the public CDN URL for a file
     */
    public getFileUrl(key: string): string {
        const parts = key.split('/');
        const path = parts.slice(0, -1).join('/');
        const file = parts[parts.length - 1];
        return `${this.publicCdnBase}/${path}/${encodeURIComponent(file)}`;
    }


    /**
     * Generate a unique key for level files
     * Returns both the storage key and the original filename
     */
    public generateLevelKey(fileId: string, filename: string): { key: string; originalFilename: string } {
        // Use the filename as-is for the key (no encoding needed)
        return {
            key: `levels/${fileId}/${filename}`,
            originalFilename: filename
        };
    }

    /**
     * Generate a unique key for zip files
     * Returns both the storage key and the original filename
     */
    public generateZipKey(fileId: string, filename: string): { key: string; originalFilename: string } {
        // Use the filename as-is for the key (no encoding needed)
        return {
            key: `zips/${fileId}/${filename}`,
            originalFilename: filename
        };
    }

    /**
     * Generate a unique key for temporary files
     */
    public generateTempKey(prefix = 'temp'): string {
        return `${prefix}/${uuidv4()}`;
    }

    /**
     * Get content type based on file extension
     */
    private getContentType(filename: string): string {
        const ext = path.extname(filename).toLowerCase();
        const contentTypes: Record<string, string> = {
            '.adofai': 'application/json',
            '.zip': 'application/zip',
            '.mp3': 'audio/mpeg',
            '.wav': 'audio/wav',
            '.ogg': 'audio/ogg',
            '.flac': 'audio/flac',
            '.m4a': 'audio/mp4',
            '.aac': 'audio/aac',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
            '.svg': 'image/svg+xml'
        };
        return contentTypes[ext] || 'application/octet-stream';
    }

    /**
     * Get storage usage statistics
     */
    public async getStorageStats(): Promise<{
        totalFiles: number;
        totalSize: number;
        byPrefix: Record<string, { count: number; size: number }>;
    }> {
        try {
            const prefixes = ['levels/', 'zips/', 'images/', 'temp/'];
            const stats = {
                totalFiles: 0,
                totalSize: 0,
                byPrefix: {} as Record<string, { count: number; size: number }>
            };

            for (const prefix of prefixes) {
                const files = await this.listFiles(prefix, 10000);
                const count = files.length;
                const size = files.reduce((sum, file) => sum + file.size, 0);

                stats.byPrefix[prefix] = { count, size };
                stats.totalFiles += count;
                stats.totalSize += size;
            }

            logger.debug('Storage statistics retrieved from Spaces', stats);
            return stats;
        } catch (error) {
            logger.error('Failed to get storage statistics from Spaces', {
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    /** Legacy HTTP shape: `{ spaces: detailedStats | null }`. */
    public async getStatsDashboard(): Promise<{
        spaces: {
            totalFiles: number;
            totalSize: number;
            byPrefix: Record<string, { count: number; size: number }>;
        } | null;
    }> {
        try {
            const spacesStats = await this.getStorageStats();
            return { spaces: spacesStats };
        } catch (error) {
            logger.warn('Failed to get Spaces storage stats', {
                error: error instanceof Error ? error.message : String(error)
            });
            return { spaces: null };
        }
    }

    private parseSpacesFolderKey(raw: string): string | null {
        if (!raw || raw.trim() === '') {
            return null;
        }

        let normalized = raw.trim().replace(/\\/g, '/').replace(/^\/+/, '');
        try {
            if (/^https?:\/\//i.test(normalized)) {
                const u = new URL(normalized);
                normalized = u.pathname.replace(/^\/+/, '');
            }
        } catch {
            // treat as plain key
        }

        const trimmed = normalized.replace(/\/+$/, '');
        const segments = trimmed.split('/').filter(Boolean);

        if (segments.length < 2) {
            return null;
        }

        const leafName = segments[segments.length - 1];
        if (!validateUuid(leafName)) {
            return null;
        }

        return trimmed;
    }

    private async deleteSpacesTreeAtPrefix(trimmedPrefix: string): Promise<boolean> {
        try {
            const listPrefix = `${trimmedPrefix}/`;
            const files = await this.listFiles(listPrefix, 10000);

            if (files.length > 0) {
                await this.deleteFiles(files.map(f => f.key));
            }

            logger.debug('deleteSpacesTreeAtPrefix: removed Spaces objects', {
                prefix: listPrefix,
                count: files.length
            });
            return true;
        } catch (error) {
            logger.error('deleteSpacesTreeAtPrefix failed:', {
                error: error instanceof Error ? error.message : String(error),
                trimmedPrefix
            });
            return false;
        }
    }

    /**
     * Delete all objects under validated Spaces folder keys (last segment must be a UUID).
     */
    public async cleanupPaths(...paths: (string | undefined | null)[]): Promise<boolean> {
        let allOk = true;

        for (const raw of paths) {
            if (raw == null || raw === '') {
                continue;
            }

            const spacesPrefix = this.parseSpacesFolderKey(raw);
            if (spacesPrefix === null) {
                logger.error('cleanupPaths: not a valid Spaces folder key', { raw });
                allOk = false;
                continue;
            }

            const ok = await this.deleteSpacesTreeAtPrefix(spacesPrefix);
            if (!ok) {
                allOk = false;
            }
        }

        return allOk;
    }

    public async deleteFolder(folderKey: string): Promise<boolean> {
        return this.cleanupPaths(folderKey);
    }

    public async deleteCdnLevelZipClustersByFileId(fileId: string): Promise<boolean> {
        if (!validateUuid(fileId)) {
            logger.error('deleteCdnLevelZipClustersByFileId: fileId must be a UUID', { fileId });
            return false;
        }

        const prefixes = [`levels/${fileId}`, `zips/${fileId}`] as const;
        let allOk = true;

        for (const trimmed of prefixes) {
            const ok = await this.deleteSpacesTreeAtPrefix(trimmed);
            if (!ok) {
                logger.warn('Level zip cluster folder deletion failed', { fileId, prefix: `${trimmed}/` });
                allOk = false;
            }
        }

        logger.debug('Level zip cluster deletion completed', { fileId, allOk });
        return allOk;
    }

    public async deleteLevelZipFiles(fileId: string): Promise<void> {
        try {
            logger.debug('Deleting level zip Spaces clusters (levels + zips)', { fileId });
            await this.deleteCdnLevelZipClustersByFileId(fileId);
            logger.debug('Successfully completed level zip cluster deletion', { fileId });
        } catch (error) {
            logger.error('Failed to delete level zip files', {
                error: error instanceof Error ? error.message : String(error),
                fileId
            });
            throw error;
        }
    }

    public async uploadLevelFile(
        filePath: string,
        fileId: string,
        originalFilename: string,
        isZip = false
    ): Promise<{
        filePath: string;
        url?: string;
        key?: string;
        originalFilename?: string;
    }> {
        try {
            const keyResult = isZip
                ? this.generateZipKey(fileId, originalFilename)
                : this.generateLevelKey(fileId, originalFilename);

            const contentType = isZip ? 'application/zip' : 'application/json';

            const result = await this.uploadFile(filePath, keyResult.key, contentType, {
                fileId,
                originalFilename: encodeURIComponent(keyResult.originalFilename),
                uploadType: isZip ? 'zip' : 'level',
                uploadedAt: new Date().toISOString()
            });

            logger.debug('Level file uploaded to Spaces', {
                fileId,
                originalFilename: keyResult.originalFilename,
                isZip,
                key: result.key,
                size: result.size
            });

            return {
                filePath: result.key,
                url: result.url,
                key: result.key,
                originalFilename: keyResult.originalFilename
            };
        } catch (error) {
            logger.error('Failed to upload level file to Spaces', {
                error: error instanceof Error ? error.message : String(error),
                fileId,
                originalFilename,
                isZip
            });
            throw error;
        }
    }

    public async uploadSongFiles(
        files: Array<{ sourcePath: string; filename: string; size: number; type: string }>,
        fileId: string
    ): Promise<{
        files: Array<{
            filename: string;
            path: string;
            size: number;
            type: string;
            url?: string;
            key?: string;
        }>;
    }> {
        try {
            const results: Array<{
                filename: string;
                path: string;
                size: number;
                type: string;
                url?: string;
                key?: string;
            }> = [];

            for (const file of files) {
                const spacesKey = `zips/${fileId}/${file.filename}`;
                const result = await this.uploadFile(
                    file.sourcePath,
                    spacesKey,
                    `audio/${file.type}`,
                    {
                        fileId,
                        originalFilename: encodeURIComponent(file.filename),
                        uploadType: 'song',
                        uploadedAt: new Date().toISOString()
                    }
                );
                results.push({
                    filename: file.filename,
                    path: result.key,
                    size: file.size,
                    type: file.type,
                    url: result.url,
                    key: result.key
                });
            }

            logger.debug('All song files uploaded to Spaces', {
                fileId,
                fileCount: files.length,
                totalSize: files.reduce((sum, f) => sum + f.size, 0)
            });
            return {
                files: results
            };
        } catch (error) {
            logger.error('Failed to upload song files to Spaces', {
                error: error instanceof Error ? error.message : String(error),
                fileId,
                fileCount: files.length
            });
            throw error;
        }
    }

    public async uploadLevelFiles(
        files: Array<{ sourcePath: string; filename: string; size: number }>,
        fileId: string
    ): Promise<{
        files: Array<{
            filename: string;
            path: string;
            size: number;
            url?: string;
            key?: string;
        }>;
    }> {
        try {
            const results: Array<{
                filename: string;
                path: string;
                size: number;
                url?: string;
                key?: string;
            }> = [];

            for (const file of files) {
                const keyResult = this.generateLevelKey(fileId, file.filename);

                const result = await this.uploadFile(
                    file.sourcePath,
                    keyResult.key,
                    'application/json',
                    {
                        fileId,
                        originalFilename: encodeURIComponent(keyResult.originalFilename),
                        uploadType: 'level',
                        uploadedAt: new Date().toISOString()
                    }
                );

                results.push({
                    filename: file.filename,
                    path: result.key,
                    size: file.size,
                    url: result.url,
                    key: result.key
                });
            }

            logger.debug('All level files uploaded to Spaces', {
                fileId,
                fileCount: files.length,
                totalSize: files.reduce((sum, f) => sum + f.size, 0)
            });

            return {
                files: results
            };
        } catch (error) {
            logger.error('Failed to upload level files to Spaces', {
                error: error instanceof Error ? error.message : String(error),
                fileId,
                fileCount: files.length
            });
            throw error;
        }
    }

}

export const spacesStorage = CdnSpacesStorage.getInstance();
