import { isIP } from 'node:net';

/**
 * Targets that can never legitimately be a vCenter (#175, epic #172).
 *
 * @ai-warning THIS IS THE INVERSE OF `plugins/oidc.ts`'s DENY-LIST, ON PURPOSE.
 *
 * An OIDC issuer is public, so that guard rejects private addresses. **A vCenter
 * is private by definition** — 10/8, 172.16/12, 192.168/16 are exactly where it
 * lives. Re-adding those here to "make the two consistent" would break every
 * legitimate deployment on the first sync. If you are reading this because the two
 * look inconsistent: they are inconsistent because the targets are opposites.
 *
 * Denied: loopback, unspecified, link-local (incl. cloud metadata).
 * Permitted: every private range, and every public address.
 *
 * @ai-warning Be honest about what this buys. Its value is LOW. The database is a
 * separate container at a private address indistinguishable from a vCenter, so
 * this cannot protect it; `169.254.169.254` matters only if someone later runs LCM
 * in a cloud VM (there is no IMDS on-prem). It is ~20 lines hedging deployment
 * drift — **not** the control doing the work. The control is the password gate on
 * trust material. Do not let this function's existence imply the endpoint is safe.
 */
export function isDeniedTarget(hostname: string): boolean {
  const kind = isIP(hostname);
  if (kind === 4) return isDeniedIpv4(hostname);
  if (kind === 6) return isDeniedIpv6(hostname.toLowerCase());
  // A hostname resolves at connect time. Resolving it here would only create a
  // TOCTOU gap between the check and the connection — and since private addresses
  // are permitted anyway, there is nothing for a rebinding attack to defeat. The
  // OIDC guard's `@ai-warning` documents the same trade for the same reason.
  return isDeniedName(hostname.toLowerCase());
}

function isDeniedName(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost');
}

function isDeniedIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // "this host"
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  // 10/8, 172.16/12, 192.168/16, 100.64/10 are all PERMITTED — see the header.
  return false;
}

function isDeniedIpv6(ip: string): boolean {
  if (ip === '::1' || ip === '::') return true; // loopback / unspecified
  // IPv4-mapped forms route to their embedded IPv4, so classify by that. Matching
  // one textual spelling is not enough: `::ffff:127.0.0.1`, `::ffff:7f00:1`, and
  // whatever `new URL()` normalizes a bracketed literal to must all be caught —
  // a dotted-only regex let the hex form slip through in the OIDC guard once.
  const embedded = ipv4MappedEmbeddedAddress(ip);
  if (embedded !== null) return isDeniedIpv4(embedded);
  if (/^fe[89ab]/.test(ip)) return true; // link-local fe80::/10
  // fc00::/7 (unique-local) is PERMITTED — it is the IPv6 equivalent of RFC1918,
  // i.e. exactly where a vCenter would live.
  return false;
}

/**
 * The embedded IPv4 of an IPv4-mapped IPv6 address (::ffff:0:0/96), in any textual
 * form; otherwise null. Assumes a valid, lower-cased IPv6 literal.
 */
function ipv4MappedEmbeddedAddress(ip: string): string | null {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(ip);
  if (dotted?.[1]) return dotted[1];

  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (hex?.[1] && hex[2]) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
  }
  return null;
}
