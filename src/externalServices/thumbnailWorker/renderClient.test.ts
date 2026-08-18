import assert from 'node:assert/strict';
import test from 'node:test';
import type {Response} from 'express';
import {
  awaitThumbnailGeneration,
  resolveThumbnailWaitMs,
  sendThumbnailRenderError,
  thumbnailGenerationWaitMs,
  ThumbnailRenderPendingError,
} from './renderClient.js';
import {ThumbnailQueueUnavailableError, thumbnailRenderJobId} from './producerHelpers.js';

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
  assert.equal(thumbnailGenerationWaitMs(), 600_000);
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

test('HTTP timeout does not restart in-flight thumbnail generation', async () => {
  const key = `in-flight-${Date.now()}-${Math.random()}`;
  let produceCount = 0;
  const produce = async () => {
    produceCount += 1;
    await new Promise(resolve => setTimeout(resolve, 120));
    return Buffer.from('png');
  };

  await assert.rejects(
    () => awaitThumbnailGeneration({key, waitMs: 20, produce}),
    (error: unknown) => error instanceof ThumbnailRenderPendingError,
  );
  await assert.rejects(
    () => awaitThumbnailGeneration({key, waitMs: 20, produce}),
    (error: unknown) => error instanceof ThumbnailRenderPendingError,
  );

  const result = await awaitThumbnailGeneration({key, waitMs: 250, produce});
  assert.equal(produceCount, 1);
  assert.equal(result.toString(), 'png');
});

test('concurrent callers share a single thumbnail produce()', async () => {
  const key = `shared-${Date.now()}-${Math.random()}`;
  let produceCount = 0;
  const produce = async () => {
    produceCount += 1;
    await new Promise(resolve => setTimeout(resolve, 40));
    return Buffer.from('shared');
  };

  const [first, second, third] = await Promise.all([
    awaitThumbnailGeneration({key, waitMs: 200, produce}),
    awaitThumbnailGeneration({key, waitMs: 200, produce}),
    awaitThumbnailGeneration({key, waitMs: 200, produce}),
  ]);

  assert.equal(produceCount, 1);
  assert.equal(first.toString(), 'shared');
  assert.equal(second.toString(), 'shared');
  assert.equal(third.toString(), 'shared');
});
