import type { Response } from 'express';
import { pipeline } from 'node:stream/promises';

export interface StorageObjectStreamResponseOptions {
    storagePath: string;
    contentType: string;
    cacheControl: string;
    openStream: (storagePath: string) => Promise<NodeJS.ReadableStream>;
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
    await pipeline(stream, res);
}
