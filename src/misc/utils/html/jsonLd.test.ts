import assert from 'node:assert/strict';
import test from 'node:test';
import { escapeJsonLd, serializeJsonLd } from '@/misc/utils/html/jsonLd.js';

test('JSON-LD serialisation cannot close its own script block', () => {
  // pass.videoLink is stored verbatim when it matches no known video host, so
  // this is the shape an attacker can persist through a pass submission.
  const payload = {
    '@type': 'VideoObject',
    url: 'https://evil.example/</script><script>alert(document.domain)</script>',
  };

  const serialized = serializeJsonLd(payload);

  assert.equal(serialized.includes('</script>'), false);
  assert.equal(serialized.includes('<'), false);
  assert.equal(serialized.includes('>'), false);
  // Still valid JSON, and the value round-trips unchanged.
  assert.equal(JSON.parse(serialized).url, payload.url);
});

test('JSON-LD escaping covers ampersands and JS line terminators', () => {
  assert.equal(escapeJsonLd('"a&b"'), '"a\\u0026b"');
  assert.equal(escapeJsonLd('"a\u2028b"'), '"a\\u2028b"');
  assert.equal(escapeJsonLd('"a\u2029b"'), '"a\\u2029b"');
});
