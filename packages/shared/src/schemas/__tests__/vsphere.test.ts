import { describe, expect, it } from 'vitest';

import {
  liveUsageListResponseSchema,
  vsphereConnectionCreateSchema,
  vsphereConnectionUpdateSchema,
  vsphereProbeSchema,
  vsphereSyncOutcomeSchema,
  vsphereTrustCertSchema,
  vsphereVerifySchema,
} from '../vsphere.js';
import type { LiveUsage } from '../vsphere.js';

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
    expect(vsphereTrustCertSchema.safeParse({ leafFingerprintSha256: fingerprint }).success).toBe(
      false,
    );
    expect(
      vsphereTrustCertSchema.safeParse({ leafFingerprintSha256: fingerprint, password: 'pw' })
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

describe('vSphere contracts — the configurable port (#199)', () => {
  const base = {
    name: 'vc-prod',
    hostname: 'vcenter.corp.local',
    username: 'svc-lcm',
    password: 'pw',
  };

  it('accepts a create with an explicit port', () => {
    const r = vsphereConnectionCreateSchema.safeParse({ ...base, port: 8443 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.port).toBe(8443);
  });

  it('defaults the port to 443 when omitted (existing payloads stay valid)', () => {
    const r = vsphereConnectionCreateSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.port).toBe(443);
  });

  it.each([0, 65536, -1, 1.5])('rejects an out-of-range or non-integer port %s', (port) => {
    expect(vsphereConnectionCreateSchema.safeParse({ ...base, port }).success).toBe(false);
  });

  it('threads a port through probe and verify, defaulting to 443', () => {
    const probe = vsphereProbeSchema.safeParse({ hostname: 'vcenter.corp.local', port: 8443 });
    expect(probe.success).toBe(true);
    if (probe.success) expect(probe.data.port).toBe(8443);
    const probeDefault = vsphereProbeSchema.safeParse({ hostname: 'vcenter.corp.local' });
    expect(probeDefault.success && probeDefault.data.port).toBe(443);
    expect(
      vsphereVerifySchema.safeParse({ hostname: 'h', username: 'u', password: 'p', port: 8443 })
        .success,
    ).toBe(true);
  });

  it('treats a port change as trust material — it requires re-entering the password', () => {
    // A port repoints where the credential is sent (host:PORT), so in disabled mode
    // it must be gated exactly like a hostname change (#199, option A).
    expect(vsphereConnectionUpdateSchema.safeParse({ port: 8443 }).success).toBe(false);
    expect(vsphereConnectionUpdateSchema.safeParse({ port: 8443, password: 'pw' }).success).toBe(
      true,
    );
  });

  it('still rejects a port smuggled inline in the hostname', () => {
    // The port has its own field; the hostname regex must keep rejecting host:port
    // so the parser-differential trick stays closed.
    expect(vsphereProbeSchema.safeParse({ hostname: 'vcenter.corp.local:8443' }).success).toBe(
      false,
    );
  });
});

describe('vsphereSyncOutcomeSchema', () => {
  it("accepts 'skipped' — the identity guard refusing is an outcome, not a failure", () => {
    // vsphere.ts's own @ai-warning: `skipped` is how the guard reports "this
    // hostname now answers as a DIFFERENT vCenter, so I refused to touch
    // anything. That refusal is the feature." A two-value 'ok' | 'failed'
    // vocabulary cannot express it and would force the UI to render the
    // guard working correctly as an error.
    expect(vsphereSyncOutcomeSchema.safeParse('skipped').success).toBe(true);
  });

  it.each(['ok', 'unreachable', 'auth_failed', 'tls_untrusted', 'identity_mismatch', 'skipped'])(
    'accepts %s',
    (outcome) => {
      expect(vsphereSyncOutcomeSchema.safeParse(outcome).success).toBe(true);
    },
  );

  it('rejects a word outside the vocabulary', () => {
    // Prisma stores `lastSyncStatus` as an untyped `String?` with no enum
    // anywhere, so this schema is the only thing standing between a typo'd
    // status column and a client rendering it.
    expect(vsphereSyncOutcomeSchema.safeParse('failed').success).toBe(false);
  });
});

describe('liveUsageListResponseSchema', () => {
  const neverFetched: LiveUsage = {
    state: 'never_fetched',
    clusterId: 'cl_1',
    connectionName: 'vc-prod',
  };
  const fresh: LiveUsage = {
    state: 'fresh',
    clusterId: 'cl_2',
    connectionName: 'vc-prod',
    memoryUsedGiB: 512,
    hostsSampled: 12,
    hostsTotal: 12,
    measuredAt: '2026-07-17T10:00:00.000Z',
    ageSeconds: 30,
  };
  const stale: LiveUsage = {
    state: 'stale',
    clusterId: 'cl_3',
    connectionName: 'vc-dr',
    memoryUsedGiB: 256,
    hostsSampled: 4,
    hostsTotal: 6,
    measuredAt: '2026-07-17T08:00:00.000Z',
    ageSeconds: 7200,
    reason: 'unreachable',
  };

  it('round-trips a mixed batch of every union member', () => {
    const parsed = liveUsageListResponseSchema.parse({ items: [neverFetched, fresh, stale] });
    expect(parsed.items.map((i) => i.state)).toEqual(['never_fetched', 'fresh', 'stale']);
  });

  it('accepts an empty batch (a fleet with no synced clusters)', () => {
    expect(liveUsageListResponseSchema.parse({ items: [] }).items).toEqual([]);
  });

  it('rejects a null item — absence is encoded by omission, never by null', () => {
    // `VsphereLiveUsageService.forCluster` returns null for "no sample"; the
    // route maps that through `neverFetched()`. If `items` ever became
    // `array(liveUsageSchema.nullable())` a null would reach a renderer and
    // reintroduce the 0%-lie the union exists to prevent.
    expect(liveUsageListResponseSchema.safeParse({ items: [null] }).success).toBe(false);
  });

  it('strips numbers smuggled into a never_fetched entry at the boundary', () => {
    // The union's core guarantee, asserted at the batch envelope: a
    // `never_fetched` entry is STRUCTURALLY incapable of carrying a number, so
    // "0% utilized" cannot be rendered from "we have no idea".
    const smuggled = { ...neverFetched, memoryUsedGiB: 99 };
    const parsed = liveUsageListResponseSchema.parse({ items: [smuggled] });
    expect(parsed.items.map((i) => 'memoryUsedGiB' in i)).toEqual([false]);
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
