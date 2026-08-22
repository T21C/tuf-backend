import assert from 'node:assert/strict';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import type { Request, Response } from 'express';
import { JWT_SECRET, OAUTH_PENDING_COOKIE } from '@/config/auth.config.js';
import { oauthPendingService } from './OAuthPendingService.js';

type CapturedCookie = { value: string; options: Record<string, unknown> };

function mockRes(): Response & { store: Map<string, CapturedCookie> } {
  const store = new Map<string, CapturedCookie>();
  const res = {
    store,
    cookie(name: string, value: string, options: Record<string, unknown>) {
      store.set(name, { value, options });
      return res;
    },
    clearCookie(name: string) {
      store.delete(name);
      return res;
    },
  };
  return res as unknown as Response & { store: Map<string, CapturedCookie> };
}

function mockReq(cookieValue?: string): Request {
  return {
    cookies: cookieValue ? { [OAUTH_PENDING_COOKIE]: cookieValue } : {},
  } as unknown as Request;
}

void test('oauth pending cookie round-trips nonce, provider, and login mode', () => {
  const res = mockRes();
  const nonce = oauthPendingService.issue(res, { provider: 'discord', mode: 'login' });
  const captured = res.store.get(OAUTH_PENDING_COOKIE);
  assert.ok(captured);
  assert.equal(captured.options.httpOnly, true);
  assert.equal(captured.options.path, '/v2/auth');

  const pending = oauthPendingService.read(mockReq(captured.value));
  assert.ok(pending);
  assert.equal(pending.typ, 'oauth_pending');
  assert.equal(pending.nonce, nonce);
  assert.equal(pending.provider, 'discord');
  assert.equal(pending.mode, 'login');
  assert.equal(pending.sub, undefined);
  assert.equal(oauthPendingService.matchesState(pending, nonce), true);
  assert.equal(oauthPendingService.matchesState(pending, 'other'), false);
});

void test('oauth pending cookie stores user id and scope for reauth', () => {
  const res = mockRes();
  const nonce = oauthPendingService.issue(res, {
    provider: 'discord',
    mode: 'reauth',
    userId: 'user-1',
    scope: 'security',
  });
  const captured = res.store.get(OAUTH_PENDING_COOKIE);
  assert.ok(captured);
  const pending = oauthPendingService.read(mockReq(captured.value));
  assert.ok(pending);
  assert.equal(pending.mode, 'reauth');
  assert.equal(pending.sub, 'user-1');
  assert.equal(pending.scope, 'security');
  assert.equal(oauthPendingService.matchesState(pending, nonce), true);
});

void test('oauth pending read returns null when cookie is missing', () => {
  assert.equal(oauthPendingService.read(mockReq()), null);
});

void test('oauth pending read returns null for expired tokens', () => {
  const token = jwt.sign(
    {
      typ: 'oauth_pending',
      nonce: 'abc',
      provider: 'discord',
      mode: 'login',
      exp: Math.floor(Date.now() / 1000) - 60,
    },
    JWT_SECRET,
  );
  assert.equal(oauthPendingService.read(mockReq(token)), null);
});

void test('oauth pending read returns null for the wrong typ', () => {
  const token = jwt.sign(
    { typ: 'step_up', nonce: 'abc', provider: 'discord', mode: 'login' },
    JWT_SECRET,
    { expiresIn: 60 },
  );
  assert.equal(oauthPendingService.read(mockReq(token)), null);
});

void test('oauth pending clear removes the cookie from the store', () => {
  const res = mockRes();
  oauthPendingService.issue(res, { provider: 'discord', mode: 'login' });
  assert.ok(res.store.get(OAUTH_PENDING_COOKIE));
  oauthPendingService.clear(res);
  assert.equal(res.store.get(OAUTH_PENDING_COOKIE), undefined);
});
