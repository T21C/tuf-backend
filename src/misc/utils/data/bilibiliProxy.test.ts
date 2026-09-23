import assert from 'node:assert/strict';
import test from 'node:test';
import {
  judgeBilibiliHtml,
  parseBilibiliViewHtml,
  parseProxyList,
  pickUnused,
  resolveBilibiliFetchMode,
  shouldStartBilibiliProxyCron,
} from './bilibiliProxy.js';

const HEALTHY_HTML = `<!doctype html>
<html>
<head>
<meta property="og:title" content="Ice and Fire / AxS 2026">
<meta property="og:image" content="https://i0.hdslb.com/bfs/archive/abc123def456.jpg">
</head>
<body>
<script>window.__INITIAL_STATE__={"videoData":{"bvid":"BV17UKVegEp2","aid":111,"cid":222,"pubdate":1710000000,"title":"Ice and Fire","pic":"https://i0.hdslb.com/bfs/archive/abc123def456.jpg","owner":{"mid":1,"name":"3w16Fan"}}};</script>
</body>
</html>`;

const WAF_412_HTML = `<!doctype html>
<html><body>
<div>错误号: 412</div>
<p>Due to security control, your request was rejected.</p>
</body></html>`;

test('judgeBilibiliHtml accepts videoData / og:title and rejects 412 WAF pages', () => {
  assert.equal(judgeBilibiliHtml(HEALTHY_HTML), 'ok');
  assert.equal(judgeBilibiliHtml(WAF_412_HTML), 'waf412');
  assert.equal(judgeBilibiliHtml(''), 'no_meta');
  assert.equal(judgeBilibiliHtml('<html><title>captcha</title></html>'), 'no_meta');
});

test('parseBilibiliViewHtml reads archive cover and metadata from healthy HTML', () => {
  const parsed = parseBilibiliViewHtml('BV17UKVegEp2', HEALTHY_HTML);
  assert.ok(parsed);
  assert.equal(parsed?.title, 'Ice and Fire');
  assert.equal(parsed?.owner.name, '3w16Fan');
  assert.equal(parsed?.pic, 'https://i0.hdslb.com/bfs/archive/abc123def456.jpg');
  assert.equal(parsed?.pubdate, 1710000000);
  assert.equal(parseBilibiliViewHtml('BV17UKVegEp2', WAF_412_HTML), null);
});

test('pickUnused skips excluded proxy ids for later waves', () => {
  const pool = ['http://1.1.1.1:80', 'http://2.2.2.2:80', 'socks5://3.3.3.3:1080', 'http://4.4.4.4:80'];
  const wave1 = pickUnused(pool, 2);
  assert.deepEqual(wave1, ['http://1.1.1.1:80', 'http://2.2.2.2:80']);
  const wave2 = pickUnused(pool, 4, new Set(wave1));
  assert.deepEqual(wave2, ['socks5://3.3.3.3:1080', 'http://4.4.4.4:80']);
  const wave3 = pickUnused(pool, 8, new Set([...wave1, ...wave2]));
  assert.deepEqual(wave3, []);
});

test('prod/staging fail closed when the healthy pool is empty', () => {
  assert.equal(
    resolveBilibiliFetchMode({ nodeEnv: 'production', healthyCount: 0 }),
    'fail_closed',
  );
  assert.equal(
    resolveBilibiliFetchMode({ nodeEnv: 'staging', healthyCount: 0 }),
    'fail_closed',
  );
  assert.equal(
    resolveBilibiliFetchMode({ nodeEnv: 'production', healthyCount: 3 }),
    'proxy',
  );
  assert.equal(
    resolveBilibiliFetchMode({ nodeEnv: 'development', healthyCount: 0 }),
    'direct',
  );
  assert.equal(
    resolveBilibiliFetchMode({ nodeEnv: 'production', disabled: true, healthyCount: 0 }),
    'direct',
  );
});

test('parseProxyList dedupes public host:port lines and ignores private addresses', () => {
  const listed = parseProxyList(`
# comment
http://113.204.79.230:9191
113.204.79.230:9191
socks5://8.8.8.8:1080
127.0.0.1:8080
10.0.0.5:80
not-a-proxy
`);
  assert.deepEqual(
    listed.map((row) => row.id),
    ['http://113.204.79.230:9191', 'socks5://8.8.8.8:1080'],
  );
});

test('cron stays off in tests and when explicitly disabled', () => {
  assert.equal(shouldStartBilibiliProxyCron({ NODE_ENV: 'test' }), false);
  assert.equal(shouldStartBilibiliProxyCron({ NODE_ENV: 'production', BILIBILI_PROXY_DISABLED: '1' }), false);
  assert.equal(shouldStartBilibiliProxyCron({ NODE_ENV: 'production' }), true);
  assert.equal(shouldStartBilibiliProxyCron({ NODE_ENV: 'development', BILIBILI_PROXY_ENABLED: '1' }), true);
  assert.equal(shouldStartBilibiliProxyCron({ NODE_ENV: 'development' }), false);
});
