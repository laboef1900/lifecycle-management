import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * In-house HMAC-SHA256 signer for the OIDC login-state cookie, replacing
 * `@fastify/cookie`'s `signed: true` support. That mechanism bakes a single
 * secret into the cookie plugin at registration time; this app's signing
 * secret instead lives in `fastify.authConfig.current.signingSecret` (DB-backed,
 * live-reloadable), so signing/verification must happen per-call with
 * whatever the CURRENT secret is — allowing rotation without re-registering
 * `@fastify/cookie`.
 *
 * Format: `<value>.<base64url(hmac-sha256(value))>`. `value` is expected to be
 * itself base64url (the login-state JSON payload), which never contains a
 * `.`, so splitting on the LAST `.` unambiguously recovers `value` even if a
 * caller's value happens to contain one.
 */
export function signLoginState(value: string, secret: string): string {
  const mac = createHmac('sha256', secret).update(value).digest('base64url');
  return `${value}.${mac}`;
}

/**
 * Verifies a `signLoginState` output and returns the original value, or
 * `null` if the input is malformed, was signed with a different secret, or
 * has been tampered with. The MAC comparison is constant-time
 * (`crypto.timingSafeEqual`) to avoid leaking timing information about how
 * many leading bytes of the MAC matched.
 */
export function verifyLoginState(signed: string, secret: string): string | null {
  const separatorIndex = signed.lastIndexOf('.');
  if (separatorIndex <= 0 || separatorIndex === signed.length - 1) return null;

  const value = signed.slice(0, separatorIndex);
  const mac = signed.slice(separatorIndex + 1);

  const macBuffer = Buffer.from(mac, 'base64url');
  const expectedMacBuffer = Buffer.from(
    createHmac('sha256', secret).update(value).digest('base64url'),
    'base64url',
  );

  if (macBuffer.length !== expectedMacBuffer.length) return null;
  if (!timingSafeEqual(macBuffer, expectedMacBuffer)) return null;

  return value;
}
