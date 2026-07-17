import { randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../server.js';
import { prisma } from './setup.js';
import { makeTestEnv } from './test-helpers.js';

/**
 * `/api/settings/vsphere` (#175) — the password gate, at the HTTP layer.
 *
 * The service-level tests prove `passwordMatches` works. These prove the ROUTES
 * actually consult it, which is where an attacker meets the gate. The env below
 * runs auth in `disabled` mode on purpose: that is what production runs, and it is
 * the mode in which every anonymous caller is an ADMIN principal — so these tests
 * are the real adversarial case, not a degraded one.
 */
let server: FastifyInstance;

beforeAll(async () => {
  server = await buildServer({
    env: makeTestEnv({ CONFIG_ENCRYPTION_KEY: randomBytes(32).toString('base64') }),
    prisma,
  });
});

afterAll(async () => {
  await server.close();
});

let seq = 0;
const uniqueName = (s: string): string => `route-vc-${s}-${++seq}`;

async function createConnection(name: string, password = 'the-real-password'): Promise<string> {
  const res = await server.inject({
    method: 'POST',
    url: '/api/settings/vsphere/connections',
    payload: { name, hostname: 'vcenter.corp.local', username: 'svc-lcm', password },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

describe('POST /api/settings/vsphere/connections', () => {
  it('creates a connection and never echoes the password back', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/settings/vsphere/connections',
      payload: {
        name: uniqueName('create'),
        hostname: 'vcenter.corp.local',
        username: 'svc-lcm',
        password: 'canary-p4ss',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain('canary-p4ss');
    expect(res.json()).not.toHaveProperty('password');
  });

  it('rejects a create with no password', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/settings/vsphere/connections',
      payload: { name: uniqueName('nopw'), hostname: 'vcenter.corp.local', username: 'svc-lcm' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects loopback as a target', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/settings/vsphere/connections',
      payload: {
        name: uniqueName('loopback'),
        hostname: '127.0.0.1',
        username: 'u',
        password: 'p',
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it('ACCEPTS a private address — a vCenter is private by definition', async () => {
    // The inverse of the OIDC deny-list. Rejecting RFC1918 here to "match" that
    // guard would break every real deployment.
    const res = await server.inject({
      method: 'POST',
      url: '/api/settings/vsphere/connections',
      payload: {
        name: uniqueName('private'),
        hostname: '10.20.30.40',
        username: 'u',
        password: 'p',
      },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe('PUT /api/settings/vsphere/connections/:id — the password gate', () => {
  it('★ rejects repointing the hostname with the WRONG password', async () => {
    const id = await createConnection(uniqueName('wrong-pw'));

    // THE attack. In `disabled` mode this caller is an anonymous ADMIN. Without
    // the server-side password check the contract's gate is decorative: repoint
    // the connection, wait for the next unattended poll, receive the credential.
    const res = await server.inject({
      method: 'PUT',
      url: `/api/settings/vsphere/connections/${id}`,
      payload: { hostname: 'attacker.corp.local', password: 'guessing' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'PASSWORD_MISMATCH' } });

    // ...and the connection still points where it did.
    const row = await prisma.vsphereConnection.findUniqueOrThrow({ where: { id } });
    expect(row.hostname).toBe('vcenter.corp.local');
  });

  it('rejects repointing the hostname with NO password (contract-level)', async () => {
    const id = await createConnection(uniqueName('no-pw'));
    const res = await server.inject({
      method: 'PUT',
      url: `/api/settings/vsphere/connections/${id}`,
      payload: { hostname: 'attacker.corp.local' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('allows repointing with the CORRECT password', async () => {
    const id = await createConnection(uniqueName('right-pw'), 'correct-horse');
    const res = await server.inject({
      method: 'PUT',
      url: `/api/settings/vsphere/connections/${id}`,
      payload: { hostname: 'vcenter-2.corp.local', password: 'correct-horse' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { hostname: string }).hostname).toBe('vcenter-2.corp.local');
  });

  it('a benign edit needs no password — friction is what kills a gate', async () => {
    const id = await createConnection(uniqueName('benign'));
    const res = await server.inject({
      method: 'PUT',
      url: `/api/settings/vsphere/connections/${id}`,
      payload: { name: uniqueName('renamed'), enabled: false },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects an insecure flag outright — there is no such mode', async () => {
    const id = await createConnection(uniqueName('insecure'));
    const res = await server.inject({
      method: 'PUT',
      url: `/api/settings/vsphere/connections/${id}`,
      payload: { insecure: true },
    });
    // A benign-looking boolean that would sail through a gate scoped to
    // "credential fields", then hand the credential to whoever spoofed DNS on the
    // next poll. The strict schema makes it unrepresentable.
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/settings/vsphere/probe — carries no credential', () => {
  it('rejects a probe that tries to smuggle a password', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/settings/vsphere/probe',
      payload: { hostname: 'vcenter.corp.local', password: 'should-be-rejected' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects link-local / cloud-metadata targets', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/settings/vsphere/probe',
      payload: { hostname: '169.254.169.254' },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('POST /api/settings/vsphere/connections/:id/trust-ca', () => {
  it('requires the password — a re-pin plus a DNS spoof is full exfiltration', async () => {
    const id = await createConnection(uniqueName('trust'));
    const fingerprint = Array.from({ length: 32 }, () => 'AB').join(':');

    const res = await server.inject({
      method: 'POST',
      url: `/api/settings/vsphere/connections/${id}/trust-ca`,
      payload: { rootFingerprintSha256: fingerprint, password: 'wrong' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'PASSWORD_MISMATCH' } });
  });
});
