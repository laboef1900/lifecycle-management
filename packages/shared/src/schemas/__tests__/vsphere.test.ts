import { describe, expect, it } from 'vitest';

import {
  vsphereConnectionCreateSchema,
  vsphereConnectionUpdateSchema,
  vsphereProbeSchema,
  vsphereTrustCaSchema,
  vsphereVerifySchema,
} from '../vsphere.js';

/**
 * These assert the ONE rule the vSphere contracts exist to enforce:
 *
 *   Stored credentials may only be sent to a destination whose trust material was
 *   written by someone who knew the password.
 *
 * They are contract tests rather than route tests on purpose — the guarantee has
 * to hold at the schema, where both server and web see it, so a future route
 * cannot quietly opt out of it.
 */
describe('vSphere contracts — the password gate on trust material', () => {
  it('rejects a create without a password (there is no stored secret to fall back to)', () => {
    const r = vsphereConnectionCreateSchema.safeParse({
      name: 'vc-prod',
      hostname: 'vcenter.corp.local',
      username: 'svc-lcm',
    });
    expect(r.success).toBe(false);
  });

  it('rejects changing the hostname without re-entering the password', () => {
    // THE attack this closes: in `disabled` mode any anonymous caller is ADMIN.
    // Repoint a saved connection at a host they control, wait for the next
    // unattended poll, and the credential arrives in cleartext — no test endpoint
    // involved, repeating forever.
    const r = vsphereConnectionUpdateSchema.safeParse({ hostname: 'attacker.corp.local' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(JSON.stringify(r.error.issues)).toContain('re-entering the password');
    }
  });

  it('rejects changing the username without re-entering the password', () => {
    const r = vsphereConnectionUpdateSchema.safeParse({ username: 'someone-else' });
    expect(r.success).toBe(false);
  });

  it('accepts a hostname change WITH the password', () => {
    const r = vsphereConnectionUpdateSchema.safeParse({
      hostname: 'vcenter-2.corp.local',
      password: 'correct horse',
    });
    expect(r.success).toBe(true);
  });

  it('allows harmless fields without a password (probes and labels must stay frictionless)', () => {
    // The rule is "gate trust material", not "gate everything" — friction on
    // benign edits is what eventually motivates someone to remove the gate.
    expect(vsphereConnectionUpdateSchema.safeParse({ name: 'vc-prod-zrh' }).success).toBe(true);
    expect(vsphereConnectionUpdateSchema.safeParse({ enabled: false }).success).toBe(true);
  });

  it('requires the password to re-pin trust (a re-pin plus a DNS spoof is full exfiltration)', () => {
    const fingerprint = Array.from({ length: 32 }, () => 'AB').join(':');
    expect(vsphereTrustCaSchema.safeParse({ rootFingerprintSha256: fingerprint }).success).toBe(
      false,
    );
    expect(
      vsphereTrustCaSchema.safeParse({ rootFingerprintSha256: fingerprint, password: 'pw' })
        .success,
    ).toBe(true);
  });

  it('verify requires a password and offers no way to omit it', () => {
    const base = { hostname: 'vcenter.corp.local', username: 'svc-lcm' };
    expect(vsphereVerifySchema.safeParse(base).success).toBe(false);
    expect(vsphereVerifySchema.safeParse({ ...base, password: '' }).success).toBe(false);
    expect(vsphereVerifySchema.safeParse({ ...base, password: 'pw' }).success).toBe(true);
  });

  it('the probe takes no credential at all — it cannot leak one', () => {
    // Not "does not require": the schema is strict, so a password cannot even be
    // smuggled in and silently forwarded.
    const r = vsphereProbeSchema.safeParse({
      hostname: 'vcenter.corp.local',
      password: 'should-be-rejected',
    });
    expect(r.success).toBe(false);
  });
});

describe('vSphere contracts — the hostname is a hostname, not a URL', () => {
  it.each([
    ['a scheme', 'https://vcenter.corp.local'],
    ['userinfo', 'vcenter.corp.local@attacker.example'],
    ['a port', 'vcenter.corp.local:8443'],
    ['a path', 'vcenter.corp.local/sdk'],
    ['a space', 'vcenter corp local'],
  ])('rejects %s', (_label, hostname) => {
    expect(vsphereProbeSchema.safeParse({ hostname }).success).toBe(false);
  });

  it.each([
    ['an FQDN', 'vcenter.corp.local'],
    ['a bare host', 'vcenter'],
    ['an IP literal', '10.20.30.40'],
  ])('accepts %s', (_label, hostname) => {
    expect(vsphereProbeSchema.safeParse({ hostname }).success).toBe(true);
  });
});

describe('vSphere contracts — there is no insecure mode', () => {
  it('cannot smuggle an insecure/allowInsecure flag through any schema', () => {
    // Every schema here is strict, so this is structural rather than a check
    // someone can forget. `tlsMode` has exactly two values and both fail closed:
    // an `insecure` boolean would be trust material disguised as a preference,
    // and would sail through a password gate scoped to "credential fields".
    for (const schema of [
      vsphereConnectionCreateSchema,
      vsphereConnectionUpdateSchema,
      vsphereProbeSchema,
      vsphereVerifySchema,
    ]) {
      expect(
        schema.safeParse({
          name: 'x',
          hostname: 'vcenter.corp.local',
          username: 'u',
          password: 'p',
          insecure: true,
        }).success,
      ).toBe(false);
    }
  });
});
