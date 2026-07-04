import { describe, expect, it } from 'vitest';

import { signLoginState, verifyLoginState } from '../plugins/login-state-signer.js';

describe('login-state-signer', () => {
  const secret = 'test-secret-0123456789abcdef-not-used-elsewhere';

  it('round-trips a signed value back to the original value', () => {
    const signed = signLoginState('a-login-state-payload', secret);
    expect(verifyLoginState(signed, secret)).toBe('a-login-state-payload');
  });

  it('produces output in the value.mac format and never embeds the secret', () => {
    const signed = signLoginState('a-login-state-payload', secret);
    expect(signed.startsWith('a-login-state-payload.')).toBe(true);
    expect(signed).not.toContain(secret);
  });

  it('rejects a value tampered with after signing', () => {
    const signed = signLoginState('a-login-state-payload', secret);
    const [value, mac] = signed.split('.');
    const tampered = `${value}-tampered.${mac}`;

    expect(verifyLoginState(tampered, secret)).toBeNull();
  });

  it('rejects a tampered MAC (bit flip in the signature itself)', () => {
    const signed = signLoginState('a-login-state-payload', secret);
    const flippedLastChar = signed.at(-1) === 'A' ? 'B' : 'A';
    const tampered = signed.slice(0, -1) + flippedLastChar;

    expect(verifyLoginState(tampered, secret)).toBeNull();
  });

  it('rejects a valid signature verified against the wrong secret', () => {
    const signed = signLoginState('a-login-state-payload', secret);

    expect(verifyLoginState(signed, 'a-completely-different-secret')).toBeNull();
  });

  it('rejects malformed input with no separator', () => {
    expect(verifyLoginState('not-a-signed-value', secret)).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(verifyLoginState('', secret)).toBeNull();
  });

  it('rejects input that is only a trailing separator with no value', () => {
    expect(verifyLoginState('.somemac', secret)).toBeNull();
  });

  it('rejects a MAC of the wrong length outright (regression guard: must not throw)', () => {
    // crypto.timingSafeEqual throws on mismatched buffer lengths; verify must
    // guard against that itself rather than let a malformed short/long MAC
    // crash the caller.
    const signed = signLoginState('a-login-state-payload', secret);
    const [value] = signed.split('.');

    expect(verifyLoginState(`${value}.short`, secret)).toBeNull();
    expect(() => verifyLoginState(`${value}.short`, secret)).not.toThrow();
  });
});
