import crypto from 'node:crypto';

const VERSION = 'v1';

/** Decode a base64 32-byte AES-256-GCM key. Returns null when the value is empty or the wrong length. */
export function decodeAes256GcmKey(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const key = Buffer.from(trimmed, 'base64');
  if (key.length !== 32) return null;
  return key;
}

/** Encrypt a secret. Output is `v1.iv.tag.ciphertext`, each part base64url. */
export function encryptSecret(plain: string, key: Buffer): string {
  if (key.length !== 32) {
    throw new Error('AES-256-GCM key must be 32 bytes');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptSecret(payload: string, key: Buffer): string {
  if (key.length !== 32) {
    throw new Error('AES-256-GCM key must be 32 bytes');
  }
  const [version, ivPart, tagPart, dataPart] = payload.split('.');
  if (version !== VERSION || !ivPart || !tagPart || !dataPart) {
    throw new Error('Invalid ciphertext');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivPart, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}
