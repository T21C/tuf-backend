import axios, { AxiosInstance, AxiosError } from 'axios';
import FormData from 'form-data';
import { logger } from './LoggerService.js';
import { ImageFileType } from '../models/cdn/CdnFile.js';

const CDN_BASE_URL = process.env.LOCAL_CDN_URL || 'http://localhost:3001';

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

class CdnService {
    private static instance: CdnService;
    private client: AxiosInstance;

    private constructor() {
        this.client = axios.create({
            baseURL: CDN_BASE_URL,
            timeout: 300000, // 30 seconds timeout for file uploads
        });
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
            if (error instanceof AxiosError && error.response?.data) {
                const errorData = error.response.data;
                logger.error('Failed to upload image to CDN:', {
                    error: errorData.error || 'Failed to upload image',
                    code: errorData.code || 'UPLOAD_ERROR',
                    details: errorData.details,
                    timestamp: new Date().toISOString()
                });
                throw new CdnError(
                    errorData.error || 'Failed to upload image',
                    errorData.code || 'UPLOAD_ERROR',
                    errorData.details
                );
            }

            logger.error('Failed to upload image to CDN:', {
                error: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString()
            });
            throw new CdnError(
                `Failed to upload ${type.toLowerCase()} image`,
                'UPLOAD_ERROR',
                { originalError: error instanceof Error ? error.message : String(error) }
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
            if (error instanceof AxiosError && error.response?.data) {
                const errorData = error.response.data;
                logger.error('Failed to upload curation icon to CDN:', {
                    error: errorData.error || 'Failed to upload curation icon',
                    code: errorData.code || 'UPLOAD_ERROR',
                    details: errorData.details,
                    timestamp: new Date().toISOString()
                });
                throw new CdnError(
                    errorData.error || 'Failed to upload curation icon',
                    errorData.code || 'UPLOAD_ERROR',
                    errorData.details
                );
            }

            logger.error('Failed to upload curation icon to CDN:', {
                error: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString()
            });
            throw new CdnError(
                'Failed to upload curation icon',
                'UPLOAD_ERROR',
                { originalError: error instanceof Error ? error.message : String(error) }
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
            if (error instanceof AxiosError && error.response?.data) {
                const errorData = error.response.data;
                logger.error('Failed to upload level thumbnail to CDN:', {
                    error: errorData.error || 'Failed to upload level thumbnail',
                    code: errorData.code || 'UPLOAD_ERROR',
                    details: errorData.details,
                    timestamp: new Date().toISOString()
                });
                throw new CdnError(
                    errorData.error || 'Failed to upload level thumbnail',
                    errorData.code || 'UPLOAD_ERROR',
                    errorData.details
                );
            }

            logger.error('Failed to upload level thumbnail to CDN:', {
                error: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString()
            });
            throw new CdnError(
                'Failed to upload level thumbnail',
                'UPLOAD_ERROR',
                { originalError: error instanceof Error ? error.message : String(error) }
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
            if (error instanceof AxiosError && error.response?.data) {
                const errorData = error.response.data;
                logger.error('Failed to upload pack icon to CDN:', {
                    error: errorData.error || 'Failed to upload pack icon',
                    code: errorData.code || 'UPLOAD_ERROR',
                    details: errorData.details,
                    timestamp: new Date().toISOString()
                });
                throw new CdnError(
                    errorData.error || 'Failed to upload pack icon',
                    errorData.code || 'UPLOAD_ERROR',
                    errorData.details
                );
            }

            logger.error('Failed to upload pack icon to CDN:', {
                error: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString()
            });
            throw new CdnError(
                'Failed to upload pack icon',
                'UPLOAD_ERROR',
                { originalError: error instanceof Error ? error.message : String(error) }
            );
        }
    }

    async uploadLevelZip(
        zipBuffer: Buffer,
        filename: string
    ): Promise<{
        success: boolean;
        fileId: string;
        metadata: any;
    }> {
        logger.debug('Starting level zip upload to CDN:', {
            filename,
            bufferSize: (zipBuffer.length / 1024 / 1024).toFixed(2) + 'MB',
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

            const response = await this.client.post('/zips', formData, {
                headers: {
                    ...formData.getHeaders(),
                    'X-File-Type': 'LEVELZIP'
                }
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
            if (error instanceof AxiosError && error.response?.data) {
                const errorData = error.response.data;
                throw new CdnError(
                    errorData.error || 'Failed to upload level zip',
                    errorData.code || 'UPLOAD_ERROR',
                    {
                        ...errorData.details,
                        originalError: errorData.error,
                        status: error.response.status,
                        responseData: errorData
                    }
                );
            }

            throw new CdnError(
                'Failed to upload level zip',
                'UPLOAD_ERROR',
                {
                    originalError: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined
                }
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
            throw new CdnError('Failed to get file', 'GET_FILE_ERROR', {
                originalError: error instanceof Error ? error.message : String(error)
            });
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
            throw new CdnError('Failed to get level files', 'GET_FILES_ERROR', {
                originalError: error instanceof Error ? error.message : String(error)
            });
        }
    }

    async getLevelSettings(fileId: string, modes?: string): Promise<any> {
        try {
            const response = await this.client.get(`/levels/${fileId}/levelData?modes=${modes}`);
            logger.debug('Level settings retrieved from CDN:', {
                fileId,
                metadata: response.data
            });
            return response.data;
        } catch (error) {
            throw new CdnError('Failed to get level settings', 'GET_LEVEL_SETTINGS_ERROR', {
                originalError: error instanceof Error ? error.message : String(error)
            });
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
            throw new CdnError('Failed to set target level', 'SET_TARGET_ERROR', {
                originalError: error instanceof Error ? error.message : String(error)
            });
        }
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
