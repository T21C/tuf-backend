import axios, { AxiosInstance, AxiosError } from 'axios';
import FormData from 'form-data';
import { logger } from './LoggerService.js';
import { ImageFileType } from '../models/cdn/CdnFile.js';
import Level from '../models/levels/Level.js';
import { getFileIdFromCdnUrl } from '../utils/Utility.js';

const CDN_BASE_URL = process.env.LOCAL_CDN_URL || 'http://localhost:3001';

const IGNORED_ERROR_CODES = ['PACK_SIZE_LIMIT_EXCEEDED', 'VALIDATION_ERROR', 'read ECONNRESET'];

export class CdnError extends Error {
    constructor(
        message: string,
        public code: string,
        public details?: any
    ) {
        super(message);
        this.name = 'CdnError';
    }
}

export type LevelMetadataTypes = 'settings' | 'actions' | 'decorations' | 'angles' | 'relativeAngles' | 'accessCount' | 'tilecount' | 'analysis';

class CdnService {
    private static instance: CdnService;
    private client: AxiosInstance;

    private constructor() {
        this.client = axios.create({
            baseURL: CDN_BASE_URL,
            timeout: 300000, // 30 seconds timeout for file uploads
        });

        // Add retry interceptor for connection errors (ECONNRESET, etc.)
        this.client.interceptors.response.use(
            (response) => response,
            async (error: AxiosError) => {
                const config = error.config as any;
                
                // Check if this is a retryable connection error
                const isRetryableError = 
                    error.code === 'ECONNRESET' ||
                    error.code === 'ECONNREFUSED' ||
                    error.code === 'ETIMEDOUT' ||
                    error.code === 'ENOTFOUND' ||
                    error.message?.includes('ECONNRESET');

                if (!isRetryableError || !config) {
                    return Promise.reject(error);
                }

                // Initialize retry count
                config.__retryCount = config.__retryCount || 0;
                const maxRetries = 3;

                if (config.__retryCount >= maxRetries) {
                    logger.error('Max retries reached for connection error', {
                        url: config.url,
                        method: config.method,
                        errorCode: error.code,
                        totalAttempts: maxRetries
                    });
                    return Promise.reject(error);
                }

                config.__retryCount += 1;

                // Exponential backoff: 1s, 2s, 4s
                const delay = Math.pow(2, config.__retryCount - 1) * 1000;

                logger.debug('Connection error, retrying request', {
                    url: config.url,
                    method: config.method,
                    errorCode: error.code,
                    attempt: config.__retryCount,
                    maxRetries,
                    delayMs: delay
                });

                await new Promise(resolve => setTimeout(resolve, delay));

                return this.client.request(config);
            }
        );
    }

    public static getInstance(): CdnService {
        if (!CdnService.instance) {
            CdnService.instance = new CdnService();
        }
        return CdnService.instance;
    }

    async uploadImage(
        imageBuffer: Buffer,
        filename: string,
        type: ImageFileType
    ): Promise<{
        success: boolean;
        fileId: string;
        urls: Record<string, string>;
        metadata: any;
    }> {
        try {
            const formData = new FormData();
            formData.append('image', imageBuffer, {
                filename,
                contentType: this.getContentType(filename)
            });

            const response = await this.client.post(`/images/${type.toLowerCase()}`, formData, {
                headers: {
                    ...formData.getHeaders(),
                    'X-File-Type': type
                }
            });

            return response.data;
        } catch (error) {
            this.handleCdnError(
                error,
                `upload ${type.toLowerCase()} image to CDN`,
                `Failed to upload ${type.toLowerCase()} image`,
                'UPLOAD_ERROR',
                ['VALIDATION_ERROR']
            );
        }
    }

    async uploadCurationIcon(
        iconBuffer: Buffer,
        filename: string
    ): Promise<{
        success: boolean;
        fileId: string;
        urls: Record<string, string>;
        metadata: any;
    }> {
        try {
            const formData = new FormData();
            formData.append('image', iconBuffer, {
                filename,
                contentType: this.getContentType(filename)
            });

            const response = await this.client.post('/images/curation_icon', formData, {
                headers: {
                    ...formData.getHeaders(),
                    'X-File-Type': 'CURATION_ICON'
                }
            });

            return response.data;
        } catch (error) {
            this.handleCdnError(
                error,
                'upload curation icon to CDN',
                'Failed to upload curation icon',
                'UPLOAD_ERROR'
            );
        }
    }

    async uploadTagIcon(
        iconBuffer: Buffer,
        filename: string
    ): Promise<{
        success: boolean;
        fileId: string;
        urls: Record<string, string>;
        metadata: any;
    }> {
        try {
            const formData = new FormData();
            formData.append('image', iconBuffer, {
                filename,
                contentType: this.getContentType(filename)
            });

            const response = await this.client.post('/images/tag_icon', formData, {
                headers: {
                    ...formData.getHeaders(),
                    'X-File-Type': 'TAG_ICON'
                }
            });

            return response.data;
        } catch (error) {
            this.handleCdnError(
                error,
                'upload tag icon to CDN',
                'Failed to upload tag icon',
                'UPLOAD_ERROR'
            );
        }
    }

    async uploadLevelThumbnail(
        thumbnailBuffer: Buffer,
        filename: string
    ): Promise<{
        success: boolean;
        fileId: string;
        urls: Record<string, string>;
        metadata: any;
    }> {
        try {
            const formData = new FormData();
            formData.append('image', thumbnailBuffer, {
                filename,
                contentType: this.getContentType(filename)
            });

            const response = await this.client.post('/images/level_thumbnail', formData, {
                headers: {
                    ...formData.getHeaders(),
                    'X-File-Type': 'LEVEL_THUMBNAIL'
                }
            });

            return response.data;
        } catch (error) {
            this.handleCdnError(
                error,
                'upload level thumbnail to CDN',
                'Failed to upload level thumbnail',
                'UPLOAD_ERROR'
            );
        }
    }

    async uploadPackIcon(
        iconBuffer: Buffer,
        filename: string
    ): Promise<{
        success: boolean;
        fileId: string;
        urls: Record<string, string>;
        metadata: any;
    }> {
        try {
            const formData = new FormData();
            formData.append('image', iconBuffer, {
                filename,
                contentType: this.getContentType(filename)
            });

            const response = await this.client.post('/images/pack_icon', formData, {
                headers: {
                    ...formData.getHeaders(),
                    'X-File-Type': 'PACK_ICON'
                }
            });

            return response.data;
        } catch (error) {
            this.handleCdnError(
                error,
                'upload pack icon to CDN',
                'Failed to upload pack icon',
                'UPLOAD_ERROR'
            );
        }
    }

    async uploadLevelZip(
        zipBuffer: Buffer,
        filename: string,
        uploadId?: string
    ): Promise<{
        success: boolean;
        fileId: string;
        metadata: any;
    }> {
        logger.debug('Starting level zip upload to CDN:', {
            filename,
            bufferSize: (zipBuffer.length / 1024 / 1024).toFixed(2) + 'MB',
            uploadId,
            timestamp: new Date().toISOString()
        });

        try {
            const formData = new FormData();
            formData.append('file', zipBuffer, {
                filename,
                contentType: 'application/zip'
            });

            logger.debug('FormData prepared for CDN upload:', {
                filename,
                contentType: 'application/zip',
                formDataSize: formData.getLengthSync()
            });

            const headers: Record<string, string> = {
                ...formData.getHeaders(),
                'X-File-Type': 'LEVELZIP'
            };
            
            if (uploadId) {
                headers['X-Upload-Id'] = uploadId;
            }

            const response = await this.client.post('/zips', formData, {
                headers
            });

            logger.debug('Level zip successfully uploaded to CDN:', {
                fileId: response.data.fileId,
                filename,
                timestamp: new Date().toISOString()
            });

            return {
                success: true,
                fileId: response.data.fileId,
                metadata: response.data.metadata
            };
        } catch (error) {
            this.handleCdnError(
                error,
                'upload level zip to CDN',
                'Failed to upload level zip',
                'UPLOAD_ERROR'
            );
        }
    }

    async checkFileExists(fileId: string): Promise<boolean> {
        try {
            const response = await this.client.head(`/${fileId}`);
            return response.status === 200;
        } catch (error) {
            if (error instanceof Error && 'response' in error && (error as any).response?.status === 404) {
                return false;
            }
            throw new CdnError('Failed to check file exists', 'CHECK_FILE_EXISTS_ERROR', {
                originalError: error instanceof Error ? error.message : String(error)
            });
        }
    }

    async getFile(fileId: string): Promise<Buffer> {
        try {
            const response = await this.client.get(`/${fileId}`, {
                responseType: 'arraybuffer'
            });
            return Buffer.from(response.data);
        } catch (error) {
            this.handleCdnError(
                error,
                'get file from CDN',
                'Failed to get file',
                'GET_FILE_ERROR'
            );
        }
    }

    async deleteFile(fileId: string, retries = 2): Promise<void> {
        let lastError: any;

        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                if (await this.checkFileExists(fileId)) {
                    const response = await this.client.delete(`/${fileId}`);
                    logger.debug('Successfully deleted CDN file', {
                        fileId,
                        status: response.status,
                        attempt: attempt + 1
                    });
                    return; // Success, exit retry loop
                } else {
                    logger.warn('CDN file does not exist, skipping deletion', {
                        fileId,
                        attempt: attempt + 1
                    });
                    return; // File doesn't exist, no need to retry
                }
            } catch (error) {
                lastError = error;

                // Don't retry for certain errors
                if (error instanceof Error && 'response' in error) {
                    const axiosError = error as AxiosError;
                    const status = axiosError.response?.status;

                    // Don't retry for 404 (file not found) or 4xx client errors
                    if (status && status >= 400 && status < 500) {
                        break; // Exit retry loop
                    }
                }

                if (attempt < retries) {
                    const delay = Math.pow(2, attempt) * 1000; // Exponential backoff: 1s, 2s, 4s
                    logger.warn('CDN file deletion failed, retrying', {
                        fileId,
                        attempt: attempt + 1,
                        maxRetries: retries + 1,
                        delayMs: delay,
                        error: error instanceof Error ? error.message : String(error)
                    });
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        // All retries failed, provide detailed error information
        let errorMessage = 'Failed to delete file';
        let errorCode = 'DELETE_FILE_ERROR';

        if (lastError instanceof Error && 'response' in lastError) {
            const axiosError = lastError as AxiosError;
            const status = axiosError.response?.status;
            const statusText = axiosError.response?.statusText;

            if (status === 404) {
                errorMessage = 'File not found in CDN service';
                errorCode = 'FILE_NOT_FOUND';
            } else if (status === 500) {
                errorMessage = 'CDN service internal error during deletion';
                errorCode = 'CDN_SERVICE_ERROR';
            } else if (status) {
                errorMessage = `CDN service returned ${status} ${statusText}`;
                errorCode = `HTTP_${status}`;
            } else if (axiosError.code === 'ECONNREFUSED') {
                errorMessage = 'CDN service is not running or not accessible';
                errorCode = 'CDN_SERVICE_UNAVAILABLE';
            } else if (axiosError.code === 'ETIMEDOUT') {
                errorMessage = 'CDN service request timed out';
                errorCode = 'CDN_SERVICE_TIMEOUT';
            }
        }

        logger.error('CDN file deletion failed after all retries', {
            fileId,
            error: lastError instanceof Error ? lastError.message : String(lastError),
            errorCode,
            errorMessage,
            totalAttempts: retries + 1
        });

        throw new CdnError(errorMessage, errorCode, {
            originalError: lastError instanceof Error ? lastError.message : String(lastError),
            fileId,
            totalAttempts: retries + 1
        });
    }

    async getFileMetadata(fileId: string): Promise<any> {
        try {
            const response = await this.client.get(`/${fileId}/metadata`);
            return response.data;
        } catch (error) {
            this.handleCdnError(
                error,
                'get file metadata from CDN, file id: ' + fileId + ' ',
                'Failed to get file metadata',
                'GET_FILE_METADATA_ERROR'
            );
        }
    }

    async getLevelFiles(fileId: string): Promise<Array<{
        name: string;
        size: number;
        hasYouTubeStream: boolean;
        songFilename?: string;
        artist?: string;
        song?: string;
        author?: string;
        difficulty?: number;
        bpm?: number;
    }>> {
        try {
            const response = await this.client.get(`/zips/${fileId}/levels`);
            return response.data.levels;
        } catch (error) {
            this.handleCdnError(
                error,
                'get level files from CDN',
                'Failed to get level files',
                'GET_FILES_ERROR'
            );
        }
    }

    async getLevelData(level: Level, modes?: LevelMetadataTypes[]): Promise<any> {
        try {
            const fileId = level.dlLink ? getFileIdFromCdnUrl(level.dlLink) : null;
            if (!fileId) {
                return null;
            }
            const response = await this.client.get(`/levels/${fileId}/levelData?modes=${modes?.join(',')}`);
            return response.data;
        } catch (error) {
            this.handleCdnError(
                error,
                'get level data from CDN, level id: ' + level?.id || 'unknown' + ' ',
                'Failed to get level data',
                'GET_LEVEL_DATA_ERROR',
                [],
                { modes: modes?.join(',') }
            );
        }
    }

    async setTargetLevel(fileId: string, targetLevel: string): Promise<{
        success: boolean;
        fileId: string;
        targetLevel: string;
    }> {
        try {
            const response = await this.client.put(`/zips/${fileId}/target-level`, {
                targetLevel
            });
            return response.data;
        } catch (error) {
            this.handleCdnError(
                error,
                'set target level in CDN',
                'Failed to set target level',
                'SET_TARGET_ERROR'
            );
        }
    }

    async getLevelMetadata(level: Level): Promise<any> {
        return (await this.getBulkLevelMetadata([level]))[0];
    }

    async generatePackDownload(request: {
        zipName: string;
        packId: number;
        packCode?: string | null;
        folderId?: number | null;
        cacheKey: string;
        tree: any;
        downloadId?: string; // Client-provided downloadId for progress tracking
    }): Promise<{
        downloadId: string;
        url: string;
        expiresAt: string;
        zipName: string;
    }> {
        try {
            // Increased timeout to 30 minutes - progress is tracked via SSE, so long waits are acceptable
            const response = await this.client.post('/zips/packs/generate', request, {timeout: 1800000}); // 30 minutes timeout
            return response.data;
        } catch (error) {
            this.handleCdnError(
                error,
                'generate pack download from CDN',
                'Failed to generate pack download',
                'PACK_DOWNLOAD_ERROR'
            );
        }
    }

    async getBulkLevelMetadata(levels: Level[]): Promise<{fileId: string, metadata: any}[]> {
        try {
            const fileIds = levels.map(level => level.dlLink ? getFileIdFromCdnUrl(level.dlLink) : null);
            const response = await this.client.post('/levels/bulk-metadata', {
                fileIds
            });

            return response.data;
        } catch (error) {
            this.handleCdnError(
                error,
                'get bulk level metadata from CDN, levels: ' + levels.map(level => level.id).join(',') + ' ',
                'Failed to get bulk level metadata',
                'GET_BULK_LEVEL_METADATA_ERROR',
                [],
                { levels: levels.map(level => level.id).join(',') }
            );
        }
    }

    /**
     * Unified error handler for CDN service errors.
     * Converts Axios errors to CdnError and handles ignored error codes.
     * 
     * @param error - The error to handle
     * @param operation - Name of the operation (for logging)
     * @param defaultMessage - Default error message if error data is not available
     * @param defaultCode - Default error code if error data is not available
     * @param additionalIgnoredCodes - Additional error codes to ignore (beyond IGNORED_ERROR_CODES)
     * @param customDetails - Additional details to include in the error
     * @throws CdnError - Always throws a CdnError
     */
    private handleCdnError(
        error: unknown,
        operation: string,
        defaultMessage: string,
        defaultCode: string = 'CDN_ERROR',
        additionalIgnoredCodes: string[] = [],
        customDetails?: any
    ): never {
        const allIgnoredCodes = [...IGNORED_ERROR_CODES, ...additionalIgnoredCodes];

        if (error instanceof AxiosError && error.response?.data) {
            const errorData = error.response.data;
            const errorCode = errorData.code || defaultCode;
            const errorMessage = errorData.error || defaultMessage;
            const shouldLog = !allIgnoredCodes.includes(errorCode) && !allIgnoredCodes.includes(errorMessage);

            if (shouldLog) {
                logger.error(`Failed to ${operation}:`, {
                    error: errorMessage,
                    code: errorCode,
                    details: errorData.details,
                    timestamp: new Date().toISOString()
                });
            }

            throw new CdnError(
                errorMessage,
                errorCode,
                {
                    ...errorData.details,
                    ...customDetails,
                    status: error.response.status,
                    responseData: errorData
                }
            );
        }

        // Handle non-Axios errors or Axios errors without response data
        logger.error(`Failed to ${operation}:`, {
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString()
        });

        throw new CdnError(
            defaultMessage,
            defaultCode,
            {
                originalError: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                ...customDetails
            }
        );
    }

    private getContentType(filename: string): string {
        const ext = filename.toLowerCase().split('.').pop();
        switch (ext) {
            case 'jpg':
            case 'jpeg':
                return 'image/jpeg';
            case 'png':
                return 'image/png';
            case 'webp':
                return 'image/webp';
            default:
                return 'application/octet-stream';
        }
    }
}

export default CdnService.getInstance();
