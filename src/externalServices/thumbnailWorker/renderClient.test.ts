import assert from 'node:assert/strict';
import test from 'node:test';
import type {Response} from 'express';
import {
  resolveThumbnailWaitMs,
  sendThumbnailRenderError,
  ThumbnailRenderPendingError,
} from './renderClient.js';
import {ThumbnailQueueUnavailableError} from './producer.js';
import {thumbnailRenderJobId} from './queue.js';

function responseRecorder() {
  const recorded = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    ended: false,
    jsonBody: undefined as unknown,
  };
  const response = {
    status(code: number) {
      recorded.statusCode = code;
      return this;
    },
    set(headers: Record<string, string>) {
      Object.assign(recorded.headers, headers);
      return this;
    },
    end() {
      recorded.ended = true;
      return this;
    },
    json(body: unknown) {
      recorded.jsonBody = body;
      return this;
    },
  } as unknown as Response;
  return {recorded, response};
}

test('normal and OpenGraph requests use bounded wait contracts', () => {
  assert.equal(resolveThumbnailWaitMs(undefined), 5000);
  assert.equal(resolveThumbnailWaitMs('anything-else'), 5000);
  assert.equal(resolveThumbnailWaitMs('og'), 15000);
});

test('pending render maps to retryable 204 without cancelling the job', () => {
  const {recorded, response} = responseRecorder();
  assert.equal(sendThumbnailRenderError(response, new ThumbnailRenderPendingError(5000)), true);
  assert.equal(recorded.statusCode, 204);
  assert.equal(recorded.headers['Retry-After'], '2');
  assert.equal(recorded.headers['Cache-Control'], 'no-store');
  assert.equal(recorded.headers['X-Thumbnail-Status'], 'processing');
  assert.equal(recorded.ended, true);
});

test('queue failure maps to retryable 503', () => {
  const {recorded, response} = responseRecorder();
  assert.equal(
    sendThumbnailRenderError(response, new ThumbnailQueueUnavailableError('offline')),
    true,
  );
  assert.equal(recorded.statusCode, 503);
  assert.deepEqual(recorded.jsonBody, {error: 'Thumbnail renderer unavailable'});
});

test('render job IDs deduplicate matching output without colliding entity types', () => {
  assert.equal(
    thumbnailRenderJobId('level_69_LARGE.png'),
    thumbnailRenderJobId('level_69_LARGE.png'),
  );
  assert.notEqual(
    thumbnailRenderJobId('level_69_LARGE.png'),
    thumbnailRenderJobId('rating_69_LARGE.png'),
  );
});
