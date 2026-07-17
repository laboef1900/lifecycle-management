import { randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import {
  VsphereConnectionsService,
  VsphereSecretDecryptError,
} from '../services/vsphere-connections.js';
import { prisma } from './setup.js';

/**
 * vCenter connection credentials (#175, epic #172) — high risk: secrets handling.
 *
 * Real Postgres via Testcontainers, and a real `secret-box` round-trip. The
 * failure paths below are the point: a credential store is judged by what it does
 * when the key is wrong, not when everything works.
 */
const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);

let seq = 0;
const uniqueName = (s: string): string => `vc-${s}-${++seq}`;

const service = (key: Buffer | null = KEY_A): VsphereConnectionsService =>
  new VsphereConnectionsService(prisma, key);

const created: string[] = [];

afterEach(async () => {
  if (created.length > 0) {
    await prisma.vsphereConnection.deleteMany({ where: { id: { in: created.splice(0) } } });
  }
});

async function makeConnection(name: string, password = 'sup3r-s3cret'): Promise<string> {
  const c = await service().create('default', {
    name,
    hostname: 'vcenter.corp.local',
    username: 'svc-lcm',
    password,
    enabled: true,
  });
  created.push(c.id);
  return c.id;
}

describe('vCenter credentials — encryption at rest', () => {
  it('round-trips the password through secret-box', async () => {
    const id = await makeConnection(uniqueName('roundtrip'), 'correct horse battery staple');
    await expect(service().revealPassword('default', id)).resolves.toBe(
      'correct horse battery staple',
    );
  });

  it('never stores the password in plaintext', async () => {
    const secret = 'plaintext-canary-9f3a';
    const id = await makeConnection(uniqueName('ciphertext'), secret);

    const row = await prisma.vsphereConnection.findUniqueOrThrow({ where: { id } });
    expect(row.passwordEnc).not.toContain(secret);
    // The AES-GCM envelope is `iv.tag.ciphertext`, all base64.
    expect(row.passwordEnc.split('.')).toHaveLength(3);
  });

  it('never returns the password to a client — not even redacted', async () => {
    const id = await makeConnection(uniqueName('noleak'));
    const response = await service().getById('default', id);
    // A `password: '••••'` field would be the first step towards someone
    // rendering the real one, so the field must not exist at all.
    expect(Object.keys(response)).not.toContain('password');
    expect(JSON.stringify(response)).not.toContain('sup3r-s3cret');
  });
});

describe('vCenter credentials — failure and recovery', () => {
  it('a wrong/rotated key fails to decrypt but PRESERVES the ciphertext', async () => {
    const id = await makeConnection(uniqueName('rotated'), 'original-secret');
    const before = await prisma.vsphereConnection.findUniqueOrThrow({ where: { id } });

    await expect(service(KEY_B).revealPassword('default', id)).rejects.toBeInstanceOf(
      VsphereSecretDecryptError,
    );

    // THE rule: never null the column to "clean up". That ciphertext may be the
    // only copy of an externally-issued credential.
    const after = await prisma.vsphereConnection.findUniqueOrThrow({ where: { id } });
    expect(after.passwordEnc).toBe(before.passwordEnc);
  });

  it('restoring the correct key recovers the credential — the degrade is reversible', async () => {
    const id = await makeConnection(uniqueName('recover'), 'recoverable-secret');

    await expect(service(KEY_B).revealPassword('default', id)).rejects.toBeInstanceOf(
      VsphereSecretDecryptError,
    );
    // ...and with the right key back, nothing was lost.
    await expect(service(KEY_A).revealPassword('default', id)).resolves.toBe('recoverable-secret');
  });

  it('a missing key fails to decrypt and still preserves the ciphertext', async () => {
    const id = await makeConnection(uniqueName('nokey'));
    await expect(service(null).revealPassword('default', id)).rejects.toBeInstanceOf(
      VsphereSecretDecryptError,
    );
    const row = await prisma.vsphereConnection.findUniqueOrThrow({ where: { id } });
    expect(row.passwordEnc.length).toBeGreaterThan(0);
  });

  it('refuses to store a credential at all when no key is configured', async () => {
    // Failing loudly beats the alternatives: storing it in the clear, or silently
    // dropping it and leaving a connection that can never authenticate.
    await expect(
      service(null).create('default', {
        name: uniqueName('nokey-create'),
        hostname: 'vcenter.corp.local',
        username: 'svc-lcm',
        password: 'x',
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: 'ENCRYPTION_KEY_MISSING' });
  });

  it('degrade is PER-CONNECTION — one bad secret does not disable the others', async () => {
    const goodId = await makeConnection(uniqueName('good'), 'good-secret');

    // Simulate a connection encrypted under a key we no longer hold.
    const badService = new VsphereConnectionsService(prisma, KEY_B);
    const bad = await badService.create('default', {
      name: uniqueName('bad'),
      hostname: 'vcenter2.corp.local',
      username: 'svc-lcm',
      password: 'unreadable-under-key-a',
      enabled: true,
    });
    created.push(bad.id);

    // Under KEY_A the second one is undecryptable...
    await expect(service(KEY_A).revealPassword('default', bad.id)).rejects.toBeInstanceOf(
      VsphereSecretDecryptError,
    );
    // ...and the first is completely unaffected. A global degrade (the AuthConfig
    // pattern) would have taken the whole integration down because one of N
    // vCenters was misconfigured.
    await expect(service(KEY_A).revealPassword('default', goodId)).resolves.toBe('good-secret');
    await expect(service(KEY_A).list('default')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: goodId })]),
    );
  });
});

describe('vCenter credentials — the password gate on trust material', () => {
  it('passwordMatches is what makes the contract gate real, not decorative', async () => {
    const id = await makeConnection(uniqueName('gate'), 'the-real-password');
    // The schema can only require that A password was sent. Without this check an
    // anonymous caller in `disabled` mode repoints a connection by sending any
    // string at all.
    await expect(service().passwordMatches('default', id, 'the-real-password')).resolves.toBe(true);
    await expect(service().passwordMatches('default', id, 'guess')).resolves.toBe(false);
  });

  it('an undecryptable secret makes the gate fail closed rather than throw', async () => {
    const id = await makeConnection(uniqueName('gate-undecryptable'));
    // The caller is as often an attacker as an admin; "wrong password" is the
    // honest answer to both, and it keeps the endpoint from leaking key state.
    await expect(service(KEY_B).passwordMatches('default', id, 'anything')).resolves.toBe(false);
  });
});

describe('vCenter connections — re-pointing resets trust', () => {
  it('changing the hostname clears the pin and the discovered identity', async () => {
    const id = await makeConnection(uniqueName('repoint'));
    await service().trustCa(
      'default',
      id,
      '-----BEGIN CERTIFICATE-----\nold\n-----END CERTIFICATE-----',
      'AB'.repeat(1).padEnd(2, 'B'),
    );
    await prisma.vsphereConnection.update({
      where: { id },
      data: { instanceUuid: 'uuid-of-the-old-vcenter', status: 'active' },
    });

    const updated = await service().update('default', id, {
      hostname: 'vcenter-new.corp.local',
      password: 'sup3r-s3cret',
    });

    // Keeping the pin would trust the OLD vCenter's CA for the NEW host; keeping
    // instanceUuid would let the identity check pass against an instance we have
    // never spoken to. Both must be re-established deliberately.
    expect(updated.pinnedRootFingerprintSha256).toBeNull();
    expect(updated.instanceUuid).toBeNull();
    expect(updated.status).toBe('never_connected');
  });

  it('re-pointing does not disturb the stored credential', async () => {
    const id = await makeConnection(uniqueName('repoint-keeps-pw'), 'keep-me');
    await service().update('default', id, {
      hostname: 'vcenter-new.corp.local',
      password: 'keep-me',
    });
    await expect(service().revealPassword('default', id)).resolves.toBe('keep-me');
  });
});

describe('vCenter connections — duplicate protection', () => {
  it('rejects a second connection with the same name', async () => {
    const name = uniqueName('dupe');
    await makeConnection(name);
    await expect(
      service().create('default', {
        name,
        hostname: 'other.corp.local',
        username: 'svc-lcm',
        password: 'x',
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: 'CONNECTION_NAME_TAKEN' });
  });

  it('the DATABASE rejects the same vCenter registered twice under two names', async () => {
    const a = await makeConnection(uniqueName('inst-a'));
    const b = await makeConnection(uniqueName('inst-b'));
    await prisma.vsphereConnection.update({
      where: { id: a },
      data: { instanceUuid: 'shared-instance-uuid' },
    });

    // Adding the same vCenter twice (its FQDN and its IP) would import every
    // cluster twice and silently DOUBLE fleet capacity — a plausible wrong answer
    // rather than an error, on the number that buys hardware.
    await expect(
      prisma.vsphereConnection.update({
        where: { id: b },
        data: { instanceUuid: 'shared-instance-uuid' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('many not-yet-connected connections coexist (NULL instanceUuid is distinct)', async () => {
    await makeConnection(uniqueName('null-a'));
    await makeConnection(uniqueName('null-b'));
    await makeConnection(uniqueName('null-c'));
    const rows = await prisma.vsphereConnection.findMany({ where: { instanceUuid: null } });
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });
});
