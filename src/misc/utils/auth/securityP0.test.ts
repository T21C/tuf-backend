import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTrustProxySetting } from '@/config/trustProxy.js';
import { parseClientIp } from './rateLimitSubjects.js';
import { rateLimitSubjectAccount } from './rateLimitSubjects.js';
import { CDN_IMAGE_MIME_TYPES, cdnImageMimeFilter } from '@/config/multerMemoryUploads.js';

test('proxy trust is disabled by default and rejects blanket trust', () => {
  assert.equal(parseTrustProxySetting(undefined), false);
  assert.equal(parseTrustProxySetting('false'), false);
  assert.equal(parseTrustProxySetting('0'), false);
  assert.throws(() => parseTrustProxySetting('true'), /unsafe/);
});

test('proxy trust accepts an exact hop count or explicit proxy list', () => {
  assert.equal(parseTrustProxySetting('1'), 1);
  assert.deepEqual(
    parseTrustProxySetting('loopback, 10.0.0.0/8'),
    ['loopback', '10.0.0.0/8'],
  );
});

test('rate-limit client IP ignores attacker-controlled forwarded headers', () => {
  assert.equal(
    parseClientIp({
      headers: { 'x-forwarded-for': '203.0.113.50, 10.0.0.2' },
      ip: '10.0.0.2',
      connection: { remoteAddress: '10.0.0.2' },
    }),
    '10.0.0.2',
  );
});

test('account rate-limit keys are normalized, stable, and do not expose PII', () => {
  const first = rateLimitSubjectAccount('  User@Example.COM ');
  const second = rateLimitSubjectAccount('user@example.com');

  assert.equal(first, second);
  assert.match(first ?? '', /^account:[a-f0-9]{64}$/);
  assert.equal(first?.includes('user@example.com'), false);
  assert.equal(rateLimitSubjectAccount('   '), null);
});

test('SVG is rejected by the shared in-memory upload filter', () => {
  assert.equal(CDN_IMAGE_MIME_TYPES.includes('image/svg+xml'), false);

  let filterErrorMessage = '';
  cdnImageMimeFilter(
    {} as never,
    { mimetype: 'image/svg+xml' } as Express.Multer.File,
    error => {
      filterErrorMessage = error?.message ?? '';
    },
  );

  assert.match(filterErrorMessage, /Invalid file type/);
});

test('CDN image policy and processor reject SVG', async () => {
  process.env.CDN_URL ??= 'http://localhost:3001';
  process.env.JOB_PROGRESS_INGEST_SECRET ??= 'test-job-progress-secret';
  process.env.CDN_INGEST_SECRET ??= 'test-cdn-ingest-secret';

  const [{ IMAGE_TYPES }, { processImage }] = await Promise.all([
    import('@/externalServices/cdnService/config.js'),
    import('@/externalServices/cdnService/services/imageProcessor.js'),
  ]);

  for (const imageType of Object.values(IMAGE_TYPES)) {
    assert.equal(imageType.formats.includes('svg' as never), false);
  }

  await assert.rejects(
    processImage('/tmp/attacker.svg', 'PROFILE', 'test-file-id', '/tmp'),
    /SVG uploads are not supported/,
  );
});
