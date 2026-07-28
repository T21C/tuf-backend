import assert from 'node:assert/strict';
import test from 'node:test';
import RateLimit from '@/models/auth/RateLimit.js';
import { RateLimiter } from '@/server/decorators/rateLimiter.js';

function responseDouble() {
  const response = {
    statusCode: 200,
    headersSent: false,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      this.headersSent = true;
      return this;
    },
  };
  return response;
}

test('login limiter checks both IP and normalized account buckets', async () => {
  const originalFindOne = RateLimit.findOne;
  const checkedSubjects: string[] = [];
  try {
    RateLimit.findOne = (async options => {
      const where = options?.where as { ip?: string } | undefined;
      if (where?.ip) checkedSubjects.push(where.ip);
      return null;
    }) as typeof RateLimit.findOne;

    let controllerCalled = false;
    const descriptor: PropertyDescriptor = {
      value: async (_req: unknown, res: ReturnType<typeof responseDouble>) => {
        controllerCalled = true;
        return res.status(401).json({ message: 'Invalid credentials' });
      },
    };
    RateLimiter({
      type: 'login-test',
      accountIdentifier: req => req.body?.emailOrUsername,
      incrementOnFailure: false,
      failClosed: true,
    })(undefined, 'login', descriptor);

    const response = responseDouble();
    await descriptor.value(
      {
        headers: {},
        ip: '192.0.2.10',
        body: { emailOrUsername: 'User@Example.COM' },
      },
      response,
    );

    assert.equal(controllerCalled, true);
    assert.equal(checkedSubjects.includes('ip:192.0.2.10'), true);
    assert.equal(checkedSubjects.some(subject => /^account:[a-f0-9]{64}$/.test(subject)), true);
  } finally {
    RateLimit.findOne = originalFindOne;
  }
});

test('sensitive limiter returns 503 without invoking controller on storage failure', async () => {
  const originalFindOne = RateLimit.findOne;
  try {
    RateLimit.findOne = (async () => {
      throw new Error('database unavailable');
    }) as typeof RateLimit.findOne;

    let controllerCalled = false;
    const descriptor: PropertyDescriptor = {
      value: async () => {
        controllerCalled = true;
      },
    };
    RateLimiter({ type: 'login-test', failClosed: true })(undefined, 'login', descriptor);

    const response = responseDouble();
    await descriptor.value({ headers: {}, ip: '192.0.2.10', body: {} }, response);

    assert.equal(controllerCalled, false);
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, {
      message: 'Authentication protection is temporarily unavailable. Please try again later.',
      code: 'RATE_LIMIT_UNAVAILABLE',
    });
  } finally {
    RateLimit.findOne = originalFindOne;
  }
});
