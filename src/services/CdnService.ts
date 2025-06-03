import axios, { AxiosInstance, AxiosError } from 'axios';
import FormData from 'form-data';
import { logger } from './LoggerService.js';

const CDN_BASE_URL = process.env.CDN_URL || 'http://localhost:3001';

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

export class CdnService {
    private static instance: CdnService;
    private client: AxiosInstance;

    private constructor() {
        this.client = axios.create({
            baseURL: CDN_BASE_URL,
            timeout: 30000, // 30 seconds timeout for file uploads
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
        purpose: 'PROFILE' | 'BANNER' | 'THUMBNAIL'
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

            const response = await this.client.post(`/images/${purpose.toLowerCase()}`, formData, {
                headers: {
                    ...formData.getHeaders(),
                    'X-File-Purpose': purpose
                }
            });

            return response.data;
        } catch (error) {
            logger.error(`Failed to upload ${purpose.toLowerCase()} image to CDN:`, error);
            
            if (error instanceof AxiosError && error.response?.data) {
                const errorData = error.response.data;
                throw new CdnError(
                    errorData.error || 'Failed to upload image',
                    errorData.code || 'UPLOAD_ERROR',
                    errorData.details
                );
            }
            
            throw new CdnError(
                `Failed to upload ${purpose.toLowerCase()} image`,
                'UPLOAD_ERROR',
                { originalError: error instanceof Error ? error.message : String(error) }
            );
        }
    }

    async deleteImage(fileId: string): Promise<void> {
        try {
            await this.client.delete(`/${fileId}`);
        } catch (error) {
            logger.error('Failed to delete image from CDN:', error);
            throw new CdnError(
                'Failed to delete image',
                'DELETE_ERROR',
                { originalError: error instanceof Error ? error.message : String(error) }
            );
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