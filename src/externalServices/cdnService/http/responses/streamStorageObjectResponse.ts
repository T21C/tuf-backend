import type { Response } from 'express';
import { pipeline } from 'node:stream/promises';

export interface StorageObjectStreamResponseOptions {
    storagePath: string;
    contentType: string;
    cacheControl: string;
    openStream: (storagePath: string) => Promise<NodeJS.ReadableStream>;
}

export function isClientAbortError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }

    const err = error as { code?: string; name?: string; message?: string };
    if (err.name === 'AbortError') {
        return true;
    }

    return err.code === 'ERR_STREAM_PREMATURE_CLOSE'
        || err.code === 'ERR_STREAM_DESTROYED'
        || err.code === 'ERR_STREAM_UNABLE_TO_PIPE'
        || err.code === 'ECONNRESET'
        || err.code === 'EPIPE'
        || err.code === 'ECANCELED';
}

/**
 * Proxy a small public storage object through the CDN service.
 *
 * The browser-visible response then receives the CDN service's CORS headers
 * instead of depending on CORS headers attached to a cached R2 custom-domain
 * object. Large downloads should keep using direct object-storage redirects.
 */
export async function streamStorageObjectResponse(
    res: Response,
    options: StorageObjectStreamResponseOptions,
): Promise<void> {
    const stream = await options.openStream(options.storagePath);

    res.setHeader('Content-Type', options.contentType);
    res.setHeader('Cache-Control', options.cacheControl);

    try {
        await pipeline(stream, res);
    } catch (error) {
        if (isClientAbortError(error)) {
            return;
        }
        throw error;
    }
}
