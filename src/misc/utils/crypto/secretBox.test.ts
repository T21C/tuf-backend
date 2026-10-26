import assert from 'node:assert/strict';
import test from 'node:test';
import {decryptSecret, encryptSecret} from './secretBox.js';

const key = Buffer.alloc(32, 7);

void test('encryptSecret round-trips and does not store the plaintext', () => {
  const encrypted = encryptSecret('refresh-token-value', key);
  assert.equal(encrypted.startsWith('v1.'), true);
  assert.equal(encrypted.includes('refresh-token-value'), false);
  assert.equal(decryptSecret(encrypted, key), 'refresh-token-value');
});

void test('encryptSecret uses a fresh iv so two writes differ', () => {
  const first = encryptSecret('same', key);
  const second = encryptSecret('same', key);
  assert.notEqual(first, second);
  assert.equal(decryptSecret(second, key), 'same');
});

void test('decryptSecret rejects a different key', () => {
  const encrypted = encryptSecret('refresh-token-value', key);
  assert.throws(() => decryptSecret(encrypted, Buffer.alloc(32, 9)));
});
