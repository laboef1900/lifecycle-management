import { randomBytes } from 'node:crypto';

import { startOfUtcMonth, type VsphereSyncOutcome, type VsphereSyncResult } from '@lcm/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../plugins/auth.js';
import { buildServer } from '../server.js';
import { SessionService } from '../services/sessions.js';
import { VsphereConnectionsService } from '../services/vsphere-connections.js';
import { VsphereJobRunner } from '../services/vsphere-job-runner.js';
import { VsphereScheduler } from '../services/vsphere-scheduler.js';
import { makeVsphereConnection, makeVsphereConnectionJob } from './factories.js';
import { prisma } from './setup.js';
import { makeOidcTestEnv, makeTestEnv } from './test-helpers.js';

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

  it('defaults the port to 443 and accepts a non-default port (#199)', async () => {
    const def = await server.inject({
      method: 'POST',
      url: '/api/settings/vsphere/connections',
      payload: {
        name: uniqueName('port-default'),
        hostname: 'vcenter.corp.local',
        username: 'svc-lcm',
        password: 'p',
      },
    });
    expect((def.json() as { port: number }).port).toBe(443);

    const alt = await server.inject({
      method: 'POST',
      url: '/api/settings/vsphere/connections',
      payload: {
        name: uniqueName('port-alt'),
        hostname: 'vcenter.corp.local',
        port: 8443,
        username: 'svc-lcm',
        password: 'p',
      },
    });
    expect(alt.statusCode).toBe(201);
    expect((alt.json() as { port: number }).port).toBe(8443);
  });

  it('★ rate-limits anonymous creates and bounds the scheduler work they seed (#199 review)', async () => {
    // This is deliberately a production-mode server: ordinary tests skip the
    // rate-limit plugin, which would make a 429 assertion vacuous. Auth remains
    // disabled, reproducing the actual anonymous-ADMIN threat model.
    await prisma.vsphereConnectionJob.deleteMany({});
    await prisma.vsphereConnection.deleteMany({});

    const prefix = uniqueName('rate-budget');
    const guardedServer = await buildServer({
      env: makeTestEnv({
        NODE_ENV: 'production',
        CONFIG_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      }),
      prisma,
    });

    const createdIds: string[] = [];
    try {
      try {
        for (let i = 0; i < 10; i++) {
          const res = await guardedServer.inject({
            method: 'POST',
            url: '/api/settings/vsphere/connections',
            remoteAddress: '198.51.100.10',
            payload: {
              name: `${prefix}-${i}`,
              hostname: `10.20.30.${i + 1}`,
              port: 4400 + i,
              username: 'attacker-selected',
              password: 'attacker-selected',
            },
          });
          expect(res.statusCode).toBe(201);
          createdIds.push((res.json() as { id: string }).id);
        }

        const limited = await guardedServer.inject({
          method: 'POST',
          url: '/api/settings/vsphere/connections',
          remoteAddress: '198.51.100.10',
          payload: {
            name: `${prefix}-blocked`,
            hostname: '10.20.30.250',
            port: 65000,
            username: 'attacker-selected',
            password: 'attacker-selected',
          },
        });
        expect(limited.statusCode).toBe(429);
        expect(createdIds).toHaveLength(10);
      } finally {
        // Stop the production timer before driving the deterministic fake-runner
        // scheduler below. `start()` waits one minute before its first tick, but
        // closing here makes the non-overlap structural rather than timing-based.
        await guardedServer.close();
      }

      // #279: every one of those anonymous creates seeds an immediately-due job but
      // carries a NULL pin — no operator has confirmed a certificate. The scheduler
      // fails closed on an unestablished pin, so it selects and runs NONE of them.
      // This is the strongest possible bound on the background work an anonymous flood
      // can seed: it is not merely rate-capped per tick, it never runs at all until a
      // human establishes the pin. (The per-tick first-contact budget for legitimately
      // pinned never-connected rows is covered in vsphere-scheduler.test.ts.)
      const now = new Date();
      let outboundRuns = 0;
      const scheduler = new VsphereScheduler(
        prisma,
        {
          run: async () => {
            outboundRuns++;
            return {
              poll: { ran: true, ok: true },
              sync: { outcome: 'ok' },
              snapshot: { attempted: true, period: startOfUtcMonth(now), failed: false },
              errorMessage: null,
            };
          },
        },
        { now: () => now },
      );

      const outcomes = await scheduler.runDueJobs();
      expect(outcomes).toHaveLength(0);
      expect(outboundRuns).toBe(0);
      // All ten remain due — nothing ran, and no stored state was mutated.
      expect(
        await prisma.vsphereConnectionJob.count({
          where: { dueAt: { lte: now }, connection: { enabled: true } },
        }),
      ).toBe(10);
    } finally {
      // Prefix cleanup also catches the 11th row if a rate-limit regression made
      // the assertion fail after persisting it.
      await prisma.vsphereConnection.deleteMany({ where: { name: { startsWith: prefix } } });
      await prisma.authConfig.deleteMany({});
    }
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

  it('★ rejects changing the port with the WRONG password — a port is a credential destination (#199)', async () => {
    const id = await createConnection(uniqueName('port-wrong-pw'));
    const res = await server.inject({
      method: 'PUT',
      url: `/api/settings/vsphere/connections/${id}`,
      payload: { port: 8443, password: 'guessing' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'PASSWORD_MISMATCH' } });
    // ...and the port is unchanged.
    const row = await prisma.vsphereConnection.findUniqueOrThrow({ where: { id } });
    expect(row.port).toBe(443);
  });

  it('rejects changing the port with NO password (contract-level, #199)', async () => {
    const id = await createConnection(uniqueName('port-no-pw'));
    const res = await server.inject({
      method: 'PUT',
      url: `/api/settings/vsphere/connections/${id}`,
      payload: { port: 8443 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('allows changing the port with the CORRECT password, keeping the pin (#199)', async () => {
    const id = await createConnection(uniqueName('port-right-pw'), 'correct-horse');
    await prisma.vsphereConnection.update({
      where: { id },
      data: { tlsPinnedSha256: 'AB:CD', instanceUuid: 'uuid-1' },
    });
    const res = await server.inject({
      method: 'PUT',
      url: `/api/settings/vsphere/connections/${id}`,
      payload: { port: 8443, password: 'correct-horse' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { port: number }).port).toBe(8443);
    // A port change is not a host change: the pinned certificate and identity survive.
    const row = await prisma.vsphereConnection.findUniqueOrThrow({ where: { id } });
    expect(row.tlsPinnedSha256).toBe('AB:CD');
    expect(row.instanceUuid).toBe('uuid-1');
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

describe('POST /api/settings/vsphere/connections/:id/trust-cert', () => {
  it('requires the password — a re-pin plus a DNS spoof is full exfiltration', async () => {
    const id = await createConnection(uniqueName('trust'));
    const fingerprint = Array.from({ length: 32 }, () => 'AB').join(':');

    const res = await server.inject({
      method: 'POST',
      url: `/api/settings/vsphere/connections/${id}/trust-cert`,
      payload: { leafFingerprintSha256: fingerprint, password: 'wrong' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'PASSWORD_MISMATCH' } });
  });
});

describe('POST /api/settings/vsphere/connections/:id/sync — "Sync now" (#192)', () => {
  it('202s immediately and never runs the sync inline — a handler must not await vCenter', async () => {
    const id = await createConnection(uniqueName('syncnow-202'));
    // The create seeds an immediately-due job with every last-run column null.
    const before = await prisma.vsphereConnectionJob.findUniqueOrThrow({
      where: { connectionId: id },
    });
    expect(before.lastSyncAt).toBeNull();

    const t0 = Date.now();
    const res = await server.inject({
      method: 'POST',
      url: `/api/settings/vsphere/connections/${id}/sync`,
    });

    // 202 Accepted: the sync is QUEUED, not performed.
    expect(res.statusCode).toBe(202);
    const dueAt = new Date((res.json() as { dueAt: string }).dueAt);
    expect(Math.abs(dueAt.getTime() - t0)).toBeLessThan(5000);

    const after = await prisma.vsphereConnectionJob.findUniqueOrThrow({
      where: { connectionId: id },
    });
    // dueAt remains ~now (create and sync-now both queue immediate work).
    expect(Math.abs(after.dueAt.getTime() - t0)).toBeLessThan(5000);
    // The observable proof there was NO inline vCenter call: no last-run column
    // moved and no claim was taken. Had the handler synced inline it would have
    // needed a real vCenter (there is none) — a clean 202 with untouched status
    // columns is exactly what "queued, not performed" looks like from the outside.
    expect(after.lastSyncAt).toBeNull();
    expect(after.lastSyncStatus).toBeNull();
    expect(after.runningSince).toBeNull();
  });

  it('upserts a job row when the connection has none yet', async () => {
    // A connection whose scheduler job row is missing (robust to provisioning
    // order): the route must CREATE it, not fail on the absent row.
    const key = randomBytes(32);
    const { id } = await makeVsphereConnection(prisma, { key, name: uniqueName('syncnow-upsert') });
    expect(
      await prisma.vsphereConnectionJob.findUnique({ where: { connectionId: id } }),
    ).toBeNull();

    const res = await server.inject({
      method: 'POST',
      url: `/api/settings/vsphere/connections/${id}/sync`,
    });
    expect(res.statusCode).toBe(202);

    const job = await prisma.vsphereConnectionJob.findUnique({ where: { connectionId: id } });
    expect(job).not.toBeNull();
    expect(Math.abs((job?.dueAt.getTime() ?? 0) - Date.now())).toBeLessThan(5000);
  });

  it('leaves an in-flight claim untouched — the claim lock keeps a double-click safe', async () => {
    // Sync-now during a live run must only pull dueAt forward; it must NOT clear
    // runningSince/lockedBy, or it would strip the running job of its claim.
    const key = randomBytes(32);
    const { id } = await makeVsphereConnection(prisma, {
      key,
      name: uniqueName('syncnow-inflight'),
    });
    const runningSince = new Date();
    await makeVsphereConnectionJob(prisma, {
      connectionId: id,
      dueAt: new Date(Date.now() + 60 * 60 * 1000),
      runningSince,
      lockedBy: 'worker-1',
    });

    const res = await server.inject({
      method: 'POST',
      url: `/api/settings/vsphere/connections/${id}/sync`,
    });
    expect(res.statusCode).toBe(202);

    const job = await prisma.vsphereConnectionJob.findUniqueOrThrow({
      where: { connectionId: id },
    });
    expect(Math.abs(job.dueAt.getTime() - Date.now())).toBeLessThan(5000);
    expect(job.runningSince?.getTime()).toBe(runningSince.getTime());
    expect(job.lockedBy).toBe('worker-1');
  });

  it('404s on an unknown connection id', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/settings/vsphere/connections/does-not-exist/sync',
    });
    expect(res.statusCode).toBe(404);
  });

  it('422s on a disabled connection — queuing a run that can never fire would be a lie', async () => {
    const id = await createConnection(uniqueName('syncnow-disabled'));
    const disable = await server.inject({
      method: 'PUT',
      url: `/api/settings/vsphere/connections/${id}`,
      payload: { enabled: false },
    });
    expect(disable.statusCode).toBe(200);

    const res = await server.inject({
      method: 'POST',
      url: `/api/settings/vsphere/connections/${id}/sync`,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'CONNECTION_DISABLED' } });
  });

  it('rejects a VIEWER with 403 when auth is not disabled', async () => {
    const oidcServer = await buildServer({
      env: makeOidcTestEnv({ CONFIG_ENCRYPTION_KEY: randomBytes(32).toString('base64') }),
      prisma,
    });
    try {
      expect(oidcServer.authConfig.current.mode).toBe('oidc');
      const viewer = await prisma.user.create({
        data: {
          issuer: 'https://idp.test',
          subject: 'viewer-syncnow',
          email: 'viewer-syncnow@example.com',
          role: 'VIEWER',
        },
      });
      const { token } = await new SessionService(prisma).create(viewer.id, 12);

      const res = await oidcServer.inject({
        method: 'POST',
        url: '/api/settings/vsphere/connections/anything/sync',
        cookies: { [SESSION_COOKIE]: token },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await oidcServer.close();
      await prisma.authConfig.deleteMany({});
    }
  });

  it('★ sets dueAt=now so the identical claim/run path syncs — but mid-month takes NO snapshot (D15a)', async () => {
    // A clean slate so the scheduler's global "what is due?" scan sees only this
    // connection (setup.ts does not truncate vSphere tables; forks run serially).
    await prisma.vsphereConnectionJob.deleteMany({});
    await prisma.vsphereConnection.deleteMany({});

    const key = randomBytes(32);
    // An established, PINNED connection — "Sync now" acts on a connection already in
    // service. Without an established pin the #279 fail-closed gate would (correctly)
    // hold this row out of the claim/run path.
    const { id } = await makeVsphereConnection(prisma, {
      key,
      name: uniqueName('syncnow-d15a'),
      lastConnectedAt: new Date('2026-07-01T00:00:00Z'),
      tlsPinnedSha256: 'AA:BB:CC:DD',
    });
    const now = new Date();
    await makeVsphereConnectionJob(prisma, {
      connectionId: id,
      // FUTURE: without Sync-now the tick would not pick this connection up.
      dueAt: new Date(now.getTime() + 60 * 60 * 1000),
      // Sync IS due — the last full sync was 7h ago, past the 6h cadence...
      lastSyncAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      // ...but the current month is ALREADY snapshotted, so snapshotDue is false.
      // This is the D15a gate: a mid-month manual sync must not take an off-boundary
      // monthly baseline snapshot.
      lastSuccessPeriod: startOfUtcMonth(now),
      // Poll not due either, so the assertion isolates the sync.
      lastPollAt: new Date(now.getTime() - 60 * 1000),
    });

    // The REAL runner (the class the production scheduler uses) and the real
    // connections service (so the seeded password decrypts), but the two
    // collect-heavy services are spies so the DISPATCH is observable without a
    // vCenter. The poll services THROW — if the poll ran, the test fails loudly.
    let syncCalls = 0;
    let snapshotCalls = 0;
    const sync = {
      syncConnection: async (
        _tenantId: string,
        connectionId: string,
      ): Promise<VsphereSyncResult> => {
        syncCalls++;
        return okSyncResult(connectionId);
      },
    };
    const snapshot = {
      runSnapshot: async (): Promise<{
        syncOutcome: VsphereSyncOutcome;
        syncError: string | null;
        snapshotPeriod: Date | null;
        clustersSnapshotted: number;
      }> => {
        snapshotCalls++;
        return {
          syncOutcome: 'ok',
          syncError: null,
          snapshotPeriod: new Date(),
          clustersSnapshotted: 0,
        };
      },
    };
    const collector = {
      collect: async (): Promise<never> => {
        throw new Error('the poll must not run in this test');
      },
    };
    const liveUsage = {
      record: async (): Promise<never> => {
        throw new Error('the poll must not run in this test');
      },
    };
    const runner = new VsphereJobRunner({
      prisma,
      connections: new VsphereConnectionsService(prisma, key),
      sync,
      snapshot,
      liveUsage,
      collector,
      isUnderPressure: () => false,
    });
    const scheduler = new VsphereScheduler(prisma, runner);

    // Baseline: dueAt is in the future, so nothing runs.
    await scheduler.runDueJobs();
    expect(syncCalls).toBe(0);

    // Sync now → dueAt = now.
    const res = await server.inject({
      method: 'POST',
      url: `/api/settings/vsphere/connections/${id}/sync`,
    });
    expect(res.statusCode).toBe(202);

    // The identical claim/run path now picks it up on the very next tick.
    await scheduler.runDueJobs();

    expect(syncCalls).toBe(1); // the sync ran...
    expect(snapshotCalls).toBe(0); // ...but NO snapshot, mid-month (the D15a gate).

    const job = await prisma.vsphereConnectionJob.findUniqueOrThrow({
      where: { connectionId: id },
    });
    expect(job.lastSyncStatus).toBe('ok'); // recorded by the shared status writer
    // lastSuccessPeriod unchanged — no new baseline was taken this month.
    expect(job.lastSuccessPeriod?.getTime()).toBe(startOfUtcMonth(now).getTime());

    // Clean up: this is now an established, PINNED connection whose job the run above
    // left due again (poll cadence). This file's fork shares the vSphere tables with
    // the scheduler suite (isolate:false, no truncation), so a leftover eligible row
    // would perturb that suite's selection-order assertions. Remove it (the job row
    // cascades).
    await prisma.vsphereConnection.deleteMany({ where: { id } });
  });
});

function okSyncResult(connectionId: string): VsphereSyncResult {
  return {
    connectionId,
    outcome: 'ok',
    clustersCreated: 0,
    clustersUpdated: 0,
    clustersMissing: 0,
    hostsCreated: 0,
    hostsUpdated: 0,
    hostsMissing: 0,
    error: null,
  };
}
