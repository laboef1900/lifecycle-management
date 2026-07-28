import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

export function decrypt(envelope: string, key: Buffer): string {
  const parts = envelope.split('.');
  if (parts.length !== 3) throw new Error('Malformed secret envelope');
  const [ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64!, 'base64'), {
    authTagLength: 16,
  });
  decipher.setAuthTag(Buffer.from(tagB64!, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64!, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}

export function loadKey(raw: string | undefined): Buffer {
  if (!raw) throw new Error('CONFIG_ENCRYPTION_KEY is required to read or write auth secrets');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32)
    throw new Error('CONFIG_ENCRYPTION_KEY must be base64 of exactly 32 bytes');
  return key;
}

export function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}
