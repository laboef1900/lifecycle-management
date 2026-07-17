import { describe, expect, it } from 'vitest';

import { isDeniedTarget } from '../vsphere-guard.js';

/**
 * The vCenter target guard is the INVERSE of the OIDC deny-list (#175).
 *
 * These tests exist mostly to stop someone "fixing the inconsistency" between the
 * two guards. They are inconsistent because the targets are opposites: an OIDC
 * issuer is public, a vCenter is private.
 */
describe('vCenter target guard — private addresses are PERMITTED', () => {
  it.each([
    ['RFC1918 10/8', '10.20.30.40'],
    ['RFC1918 172.16/12', '172.16.0.5'],
    ['RFC1918 192.168/16', '192.168.1.10'],
    ['CGNAT 100.64/10', '100.64.0.1'],
    ['IPv6 unique-local', 'fd00::1'],
    ['an internal FQDN', 'vcenter.corp.local'],
    ['a public address', '203.0.113.10'],
  ])('permits %s', (_label, host) => {
    // Re-adding RFC1918 here to match plugins/oidc.ts would break every real
    // deployment on the first sync — a vCenter lives at exactly these addresses.
    expect(isDeniedTarget(host)).toBe(false);
  });
});

describe('vCenter target guard — never-legitimate targets are denied', () => {
  it.each([
    ['loopback', '127.0.0.1'],
    ['loopback range', '127.1.2.3'],
    ['this-host', '0.0.0.0'],
    ['link-local / cloud metadata', '169.254.169.254'],
    ['IPv6 loopback', '::1'],
    ['IPv6 unspecified', '::'],
    ['IPv6 link-local', 'fe80::1'],
    ['localhost', 'localhost'],
  ])('denies %s', (_label, host) => {
    expect(isDeniedTarget(host)).toBe(true);
  });

  it.each([
    ['dotted IPv4-mapped loopback', '::ffff:127.0.0.1'],
    ['HEX IPv4-mapped loopback', '::ffff:7f00:1'],
    ['hex IPv4-mapped metadata', '::ffff:a9fe:a9fe'],
  ])('denies %s — matching one spelling is not enough', (_label, host) => {
    // The OIDC guard was once bitten by exactly this: a dotted-only regex let the
    // hex form through. Both spellings reach the same address.
    expect(isDeniedTarget(host)).toBe(true);
  });
});
