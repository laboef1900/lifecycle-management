/**
 * Validates a post-login return target, returning the canonical path or null.
 * Accepts ONLY a same-origin, path-absolute URL — a single leading slash, no
 * scheme or authority — to close the open-redirect surface. Rejects
 * protocol-relative (`//host`), backslash tricks (browsers may fold `\`→`/`),
 * control chars, and anything that resolves to a different origin. Dot-segments
 * are normalized away by re-serializing through the URL parser.
 *
 * Pure and DOM-free — it validates against a fixed sentinel origin and returns
 * a relative path — so the server's OIDC redirect handling and the web client's
 * local-login navigation share this one canonical guard instead of each
 * hand-rolling its own.
 *
 * @ai-warning Do NOT weaken this to a naive `startsWith('/')` prefix check: the
 * URL-parser round-trip is what actually defeats the `\`, control-char, and
 * dot-segment bypasses. A prefix check lets `/\evil.com` and `/<TAB>/evil.com`
 * through to a cross-origin navigation.
 */
export function safeRedirectPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  if (value.includes('\\')) return null;
  // Reject control chars/whitespace a browser might fold into an authority.
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return null;
  }
  try {
    const resolved = new URL(value, 'http://localhost');
    if (resolved.origin !== 'http://localhost') return null;
    const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
    // A dot-segment input (e.g. '/..//host') can normalize to a '//host'
    // pathname that is protocol-relative once used as a Location — reject it so
    // the function never returns an off-origin target, even to a caller that
    // forgets to re-validate.
    if (path.startsWith('//')) return null;
    return path;
  } catch {
    return null;
  }
}
