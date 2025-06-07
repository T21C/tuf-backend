import axios, { AxiosInstance, AxiosError } from 'axios';
import FormData from 'form-data';
import { logger } from './LoggerService.js';

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
        type: 'PROFILE' | 'BANNER' | 'THUMBNAIL'
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

    async uploadLevelZip(
        zipBuffer: Buffer,
        filename: string
    ): Promise<{
        success: boolean;
        fileId: string;
        metadata: any;
    }> {
        logger.info('Starting level zip upload to CDN:', {
            filename,
            bufferSize: zipBuffer.length,
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

            logger.info('Level zip successfully uploaded to CDN:', {
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
            logger.error('Failed to upload level zip to CDN:', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                filename,
                bufferSize: zipBuffer.length,
                timestamp: new Date().toISOString()
            });
            
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

    async deleteFile(fileId: string): Promise<void> {
        try {
            if (await this.checkFileExists(fileId)) {
                await this.client.delete(`/${fileId}`);
            }
        } catch (error) {
            throw new CdnError('Failed to delete file', 'DELETE_FILE_ERROR', {
                originalError: error instanceof Error ? error.message : String(error)
            });
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
            throw new CdnError('Failed to get level files', 'GET_FILES_ERROR', {
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