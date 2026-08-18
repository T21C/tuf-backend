import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import type { Response } from 'express';

import { isClientAbortError, streamStorageObjectResponse } from './streamStorageObjectResponse.js';

class ResponseSink extends Writable {
    readonly chunks: Buffer[] = [];
    readonly headers = new Map<string, string | number | readonly string[]>();

    setHeader(name: string, value: string | number | readonly string[]): this {
        this.headers.set(name.toLowerCase(), value);
        return this;
    }

    override _write(
        chunk: Buffer | string,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
    ): void {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
    }
}

void test('storage image response streams bytes without redirecting to the public bucket', async () => {
    const response = new ResponseSink();
    const requestedPaths: string[] = [];

    await streamStorageObjectResponse(response as unknown as Response, {
        storagePath: 'images/difficulty_icon/file-id/original.png',
        contentType: 'image/png',
        cacheControl: 'public, max-age=31536000, immutable',
        openStream: async storagePath => {
            requestedPaths.push(storagePath);
            return Readable.from([Buffer.from('image-bytes')]);
        },
    });

    assert.deepEqual(requestedPaths, ['images/difficulty_icon/file-id/original.png']);
    assert.equal(Buffer.concat(response.chunks).toString(), 'image-bytes');
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(response.headers.has('location'), false);
});

void test('client abort during stream is ignored', async () => {
    const response = new ResponseSink();
    response.destroy();

    await streamStorageObjectResponse(response as unknown as Response, {
        storagePath: 'images/difficulty_icon/file-id/original.png',
        contentType: 'image/png',
        cacheControl: 'public, max-age=31536000, immutable',
        openStream: async () => Readable.from([Buffer.from('image-bytes')]),
    });
});

void test('isClientAbortError matches stream close codes', () => {
    assert.equal(isClientAbortError(Object.assign(new Error('Premature close'), {
        code: 'ERR_STREAM_PREMATURE_CLOSE',
    })), true);
    assert.equal(isClientAbortError(Object.assign(new Error('Cannot pipe'), {
        code: 'ERR_STREAM_UNABLE_TO_PIPE',
    })), true);
    assert.equal(isClientAbortError(Object.assign(new Error('aborted'), { name: 'AbortError' })), true);
    assert.equal(isClientAbortError(new Error('R2 timeout')), false);
});
