import AWS from 'aws-sdk';
import { logger } from '@/server/services/core/LoggerService.js';
import { CDN_IMMUTABLE_CACHE_CONTROL } from '@/externalServices/cdnService/config.js';
import { requireCdnR2StorageConfig } from '@/externalServices/cdnService/services/r2Client.js';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4, validate as validateUuid } from 'uuid';

dotenv.config();

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

/** Cloudflare R2 (S3 API) for CDN objects: uploads, deletes, public URLs. */
export class CdnSpacesStorage {
    private static instance: CdnSpacesStorage;

    private s3: AWS.S3;
    private bucket: string;
    private publicCdnBase: string;

    constructor() {
        const cfg = requireCdnR2StorageConfig();
        this.s3 = cfg.s3;
        this.bucket = cfg.bucket;
        this.publicCdnBase = cfg.publicCdnBase;

        logger.info('R2 object storage initialized', {
            bucket: this.bucket,
            publicCdnBase: this.publicCdnBase
        });
    }

    public static getInstance(): CdnSpacesStorage {
        if (!CdnSpacesStorage.instance) {
            CdnSpacesStorage.instance = new CdnSpacesStorage();
        }
        return CdnSpacesStorage.instance;
    }

    private async putObject(
        params: Omit<AWS.S3.PutObjectRequest, 'Bucket' | 'ACL'>
    ): Promise<AWS.S3.ManagedUpload.SendData> {
        return this.s3.upload({ ...params, Bucket: this.bucket }).promise();
    }

    /**
     * Upload a file to R2 (streaming).
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
                bucket: this.bucket
            });

            const fileStream = fs.createReadStream(filePath);
            const result = await this.putObject({
                Key: key,
                Body: fileStream,
                ContentType: resolvedContentType,
                CacheControl: cacheControl,
                Metadata: meta
            });

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
     * Upload a buffer directly to R2.
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
                contentType: resolvedContentType
            });

            const result = await this.putObject({
                Key: key,
                Body: buffer,
                ContentType: resolvedContentType,
                CacheControl: cacheControl,
                Metadata: meta
            });

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
                Bucket: this.bucket,
                Key: key
            };

            logger.debug('Downloading file from Spaces', { key, bucket: this.bucket });

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
     * Stream a file from Spaces to a local path without buffering the whole object in memory.
     */
    public async downloadFileToPathStreaming(key: string, localPath: string): Promise<void> {
        await fs.promises.mkdir(path.dirname(localPath), { recursive: true });

        const params: AWS.S3.GetObjectRequest = {
            Bucket: this.bucket,
            Key: key
        };

        logger.debug('Downloading file from Spaces (streaming)', { key, localPath, bucket: this.bucket });

        const stream = this.s3.getObject(params).createReadStream();
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
                Bucket: this.bucket,
                Key: normalizedKey
            };

            logger.debug('Deleting file from object storage', { key: normalizedKey, bucket: this.bucket });

            await this.s3.deleteObject(deleteParams).promise();

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
                Bucket: this.bucket,
                Delete: {
                    Objects: normalizedKeys.map(key => ({ Key: key }))
                }
            };

            logger.debug('Deleting multiple files from Spaces', {
                count: normalizedKeys.length,
                keys: normalizedKeys.slice(0, 5), // Log first 5 keys
                bucket: this.bucket
            });

            const result = await this.s3.deleteObjects(deleteParams).promise();

            if (result.Errors && result.Errors.length > 0) {
                logger.warn('Some files failed to delete from bucket', {
                    errors: result.Errors,
                    deletedCount: result.Deleted?.length || 0
                });
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
                Bucket: this.bucket,
                Prefix: prefix,
                MaxKeys: maxKeys
            };

            logger.debug('Listing files in Spaces', { prefix, maxKeys, bucket: this.bucket });

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
     * Paginate ListObjectsV2 and yield every object key (optional prefix). For maintenance scripts.
     */
    public async *iterateObjectKeys(prefix = ''): AsyncGenerator<string, void, undefined> {
        let continuationToken: string | undefined;
        do {
            const params: AWS.S3.ListObjectsV2Request = {
                Bucket: this.bucket,
                Prefix: prefix,
                MaxKeys: 1000,
            };
            if (continuationToken) {
                params.ContinuationToken = continuationToken;
            }
            const result = await this.s3.listObjectsV2(params).promise();
            for (const obj of result.Contents ?? []) {
                if (obj.Key) {
                    yield obj.Key;
                }
            }
            continuationToken = result.IsTruncated
                ? result.NextContinuationToken ?? undefined
                : undefined;
        } while (continuationToken);
    }

    /**
     * Check if a file exists in Spaces
     */
    public async fileExists(key: string): Promise<boolean> {
        try {
            const headParams: AWS.S3.HeadObjectRequest = {
                Bucket: this.bucket,
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
                Bucket: this.bucket,
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
                Bucket: this.bucket,
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
                Bucket: this.bucket,
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

    /**
     * Generic uploader for an "original archive" payload that may be a .zip, .rar, .7z,
     * .tar, or .tar.gz. Uses the same `zips/{fileId}/...` keyspace as `uploadLevelFile`
     * so legacy `originalZip` readers keep finding the object via the path stored in
     * CdnFile.metadata.
     */
    public async uploadArchiveFile(
        filePath: string,
        fileId: string,
        originalFilename: string,
        contentType: string
    ): Promise<{
        filePath: string;
        url?: string;
        key?: string;
        originalFilename?: string;
        contentType: string;
    }> {
        try {
            const keyResult = this.generateZipKey(fileId, originalFilename);

            const result = await this.uploadFile(filePath, keyResult.key, contentType, {
                fileId,
                originalFilename: encodeURIComponent(keyResult.originalFilename),
                uploadType: 'archive',
                contentType,
                uploadedAt: new Date().toISOString()
            });

            logger.debug('Archive file uploaded to Spaces', {
                fileId,
                originalFilename: keyResult.originalFilename,
                contentType,
                key: result.key,
                size: result.size
            });

            return {
                filePath: result.key,
                url: result.url,
                key: result.key,
                originalFilename: keyResult.originalFilename,
                contentType
            };
        } catch (error) {
            logger.error('Failed to upload archive file to Spaces', {
                error: error instanceof Error ? error.message : String(error),
                fileId,
                originalFilename,
                contentType
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
