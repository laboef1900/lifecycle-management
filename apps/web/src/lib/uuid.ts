/**
 * RFC 4122 v4 UUID via `crypto.getRandomValues`, NOT `crypto.randomUUID()`.
 * The latter is spec'd secure-context-only (HTTPS/localhost); this app's
 * production deployment deliberately serves plain HTTP internally (CLAUDE.md
 * — HSTS is off), so `crypto.randomUUID` can be undefined there.
 * `crypto.getRandomValues` carries no such restriction.
 */
export function generateUuidV4(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const withVersion = Array.from(bytes).map((byte, i) => {
    if (i === 6) return (byte & 0x0f) | 0x40; // version 4
    if (i === 8) return (byte & 0x3f) | 0x80; // variant 10
    return byte;
  });
  const hex = withVersion.map((byte) => byte.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}
