import AWS from 'aws-sdk';
import { logger } from '../../../server/services/LoggerService.js';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

interface SpacesConfig {
    accessKeyId: string;
    secretAccessKey: string;
    endpoint: string;
    cdnEndpoint: string;
    region: string;
    bucket: string;
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

export class SpacesStorageManager {
    private static instance: SpacesStorageManager;
    private s3: AWS.S3 = new AWS.S3();
    private config: SpacesConfig;

    constructor() {
        this.config = this.loadConfig();
        this.initializeS3();
    }

    public static getInstance(): SpacesStorageManager {
        if (!SpacesStorageManager.instance) {
            SpacesStorageManager.instance = new SpacesStorageManager();
        }
        return SpacesStorageManager.instance;
    }

    private loadConfig(): SpacesConfig {
        const accessKeyId = process.env.DIGITAL_OCEAN_KEY;
        const secretAccessKey = process.env.DIGITAL_OCEAN_SECRET;
        const region = process.env.DIGITAL_OCEAN_REGION || 'sgp1';
        const bucket = process.env.DIGITAL_OCEAN_BUCKET;
        const cdnEndpoint = process.env.DIGITAL_OCEAN_CDN_ENDPOINT;

        if (!accessKeyId || !secretAccessKey || !bucket || !cdnEndpoint) {
            throw new Error('Missing required DigitalOcean Spaces environment variables: DIGITAL_OCEAN_KEY, DIGITAL_OCEAN_SECRET, DIGITAL_OCEAN_BUCKET, DIGITAL_OCEAN_CDN_ENDPOINT');
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

    private initializeS3(): void {
        this.s3 = new AWS.S3({
            accessKeyId: this.config.accessKeyId,
            secretAccessKey: this.config.secretAccessKey,
            endpoint: this.config.endpoint,
            region: this.config.region,
            s3ForcePathStyle: true, // Required for DigitalOcean Spaces
            signatureVersion: 'v4'
        });

        logger.info('DigitalOcean Spaces S3 client initialized', {
            endpoint: this.config.endpoint,
            region: this.config.region,
            bucket: this.config.bucket
        });
    }

    /**
     * Upload a file to DigitalOcean Spaces
     */
    public async uploadFile(
        filePath: string,
        key: string,
        contentType?: string,
        metadata?: Record<string, string>
    ): Promise<UploadResult> {
        try {
            const fileStats = await fs.promises.stat(filePath);

            logger.debug('file upload stats', fileStats)

            // Use file stream instead of loading entire file into memory
            const fileStream = fs.createReadStream(filePath);

            const uploadParams: AWS.S3.PutObjectRequest = {
                Bucket: this.config.bucket,
                Key: key,
                Body: fileStream,
                ContentType: contentType || this.getContentType(key),
                Metadata: metadata || {},
                ACL: 'private' // Keep files private by default
            };

            logger.debug('Uploading file to Spaces (streaming)', {
                key,
                size: fileStats.size,
                contentType: uploadParams.ContentType,
                bucket: this.config.bucket
            });

            const result = await this.s3.upload(uploadParams).promise();

            logger.debug('File uploaded to Spaces successfully', {
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
            logger.error('Failed to upload file to Spaces', {
                error: error instanceof Error ? error.message : String(error),
                key,
                filePath
            });
            throw error;
        }
    }

    /**
     * Upload a buffer directly to DigitalOcean Spaces
     */
    public async uploadBuffer(
        buffer: Buffer,
        key: string,
        contentType?: string,
        metadata?: Record<string, string>
    ): Promise<UploadResult> {
        try {
            const uploadParams: AWS.S3.PutObjectRequest = {
                Bucket: this.config.bucket,
                Key: key,
                Body: buffer,
                ContentType: contentType || this.getContentType(key),
                Metadata: metadata || {},
                ACL: 'private'
            };

            logger.debug('Uploading buffer to Spaces', {
                key,
                size: buffer.length,
                contentType: uploadParams.ContentType,
                bucket: this.config.bucket
            });

            const result = await this.s3.upload(uploadParams).promise();

            logger.debug('Buffer uploaded to Spaces successfully', {
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
            logger.error('Failed to upload buffer to Spaces', {
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
                Bucket: this.config.bucket,
                Key: key
            };

            logger.debug('Downloading file from Spaces', { key, bucket: this.config.bucket });

            const result = await this.s3.getObject(downloadParams).promise();

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
     * Delete a file from DigitalOcean Spaces
     */
    public async deleteFile(key: string): Promise<void> {
        try {
            const deleteParams: AWS.S3.DeleteObjectRequest = {
                Bucket: this.config.bucket,
                Key: key
            };

            logger.debug('Deleting file from Spaces', { key, bucket: this.config.bucket });

            await this.s3.deleteObject(deleteParams).promise();

            logger.debug('File deleted from Spaces successfully', { key });
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
            const deleteParams: AWS.S3.DeleteObjectsRequest = {
                Bucket: this.config.bucket,
                Delete: {
                    Objects: keys.map(key => ({ Key: key }))
                }
            };

            logger.debug('Deleting multiple files from Spaces', {
                count: keys.length,
                keys: keys.slice(0, 5), // Log first 5 keys
                bucket: this.config.bucket
            });

            const result = await this.s3.deleteObjects(deleteParams).promise();

            if (result.Errors && result.Errors.length > 0) {
                logger.warn('Some files failed to delete from Spaces', {
                    errors: result.Errors,
                    deletedCount: result.Deleted?.length || 0
                });
            }

            logger.debug('Files deleted from Spaces', {
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

    /**
     * List files in a directory/prefix
     */
    public async listFiles(prefix: string, maxKeys = 1000): Promise<SpacesFile[]> {
        try {
            const listParams: AWS.S3.ListObjectsV2Request = {
                Bucket: this.config.bucket,
                Prefix: prefix,
                MaxKeys: maxKeys
            };

            logger.debug('Listing files in Spaces', { prefix, maxKeys, bucket: this.config.bucket });

            const result = await this.s3.listObjectsV2(listParams).promise();

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
                Bucket: this.config.bucket,
                Key: key
            };

            await this.s3.headObject(headParams).promise();
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
                Bucket: this.config.bucket,
                Key: key
            };

            const result = await this.s3.headObject(headParams).promise();
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
                Bucket: this.config.bucket,
                Key: key
            };

            const response = await this.s3.getObject(params).promise();

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
                Bucket: this.config.bucket,
                Key: key,
                Range: `bytes=${start}-${end}`
            };

            const response = await this.s3.getObject(params).promise();

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
     * @param _expiresIn - Deprecated, kept for backwards compatibility
     */
    public async getPresignedUrl(key: string, _expiresIn = 3600): Promise<string> {
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
        return `${this.config.cdnEndpoint}/${encodeURIComponent(key)}`;
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
}

export const spacesStorage = SpacesStorageManager.getInstance();
