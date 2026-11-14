import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeBilibiliImageUrl, resolveBilibiliImageRedirect} from './bilibiliImageUrl.js';

void test('bilibili image proxy accepts hdslb and biliimg stills', () => {
  assert.equal(
    normalizeBilibiliImageUrl('https://i0.hdslb.com/bfs/archive/abc123.jpg'),
    'https://i0.hdslb.com/bfs/archive/abc123.jpg',
  );
  assert.equal(
    normalizeBilibiliImageUrl('https://i0.hdslb.com/bfs/archive/abc.jpg@672w_378h_1c.webp'),
    'https://i0.hdslb.com/bfs/archive/abc.jpg@672w_378h_1c.webp',
  );
  assert.equal(
    normalizeBilibiliImageUrl('http://i1.hdslb.com/bfs/face/a.jpg'),
    'https://i1.hdslb.com/bfs/face/a.jpg',
  );
  assert.equal(
    normalizeBilibiliImageUrl('https://i0.hdslb.com/bfs/face/a.jpg?x=1#frag'),
    'https://i0.hdslb.com/bfs/face/a.jpg?x=1',
  );
  assert.equal(
    normalizeBilibiliImageUrl('https://article.biliimg.com/bfs/article/a.png'),
    'https://article.biliimg.com/bfs/article/a.png',
  );
});

void test('bilibili image proxy rejects other hosts and non-images', () => {
  for (const raw of [
    'https://example.com/a.jpg',
    'https://i0.hdslb.com.evil.example/a.jpg',
    'https://evil.example/a.jpg?host=i0.hdslb.com',
    'https://user:pass@i0.hdslb.com/bfs/face/a.jpg',
    'https://i0.hdslb.com/bfs/face/a.html',
    'javascript:alert(1)',
    'https://i0.hdslb.com:444/bfs/face/a.jpg',
  ]) {
    assert.equal(normalizeBilibiliImageUrl(raw), null, raw);
  }
});

void test('bilibili image redirects stay on an allowed image host', () => {
  const current = 'https://i0.hdslb.com/bfs/archive/abc.jpg';
  assert.equal(
    resolveBilibiliImageRedirect(current, 'https://i1.hdslb.com/bfs/archive/abc.jpg'),
    'https://i1.hdslb.com/bfs/archive/abc.jpg',
  );
  assert.equal(resolveBilibiliImageRedirect(current, 'https://evil.example/a.jpg'), null);
  assert.equal(resolveBilibiliImageRedirect(current, '//evil.example/a.jpg'), null);
});
