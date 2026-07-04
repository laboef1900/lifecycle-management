import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encrypt, decrypt, loadKey, generateSecret } from '../secret-box.js';

const key = randomBytes(32);

describe('secret-box', () => {
  it('roundtrips', () => {
    const env = encrypt('client-secret', key);
    expect(env).not.toContain('client-secret');
    expect(decrypt(env, key)).toBe('client-secret');
  });
  it('roundtrips empty plaintext', () => {
    const env = encrypt('', key);
    expect(decrypt(env, key)).toBe('');
  });
  it('rejects a tampered envelope', () => {
    const env = encrypt('x', key).split('.');
    env[2] = Buffer.from('tampered').toString('base64');
    expect(() => decrypt(env.join('.'), key)).toThrow();
  });
  it('rejects a wrong key', () => {
    expect(() => decrypt(encrypt('x', key), randomBytes(32))).toThrow();
  });
  it('loadKey requires 32 base64 bytes', () => {
    expect(() => loadKey(undefined)).toThrow(/CONFIG_ENCRYPTION_KEY/);
    expect(() => loadKey('short')).toThrow();
    expect(loadKey(randomBytes(32).toString('base64')).length).toBe(32);
  });
  it('generateSecret returns 32-byte base64url', () => {
    expect(Buffer.from(generateSecret(), 'base64url').length).toBe(32);
  });
});
