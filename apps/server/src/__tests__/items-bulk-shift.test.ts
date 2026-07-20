import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../plugins/auth.js';
import { buildServer } from '../server.js';
import { SessionService } from '../services/sessions.js';

import { makeApplication, makeCluster, makeEvent } from './factories.js';
import { prisma } from './setup.js';
import { makeOidcTestEnv, makeTestEnv } from './test-helpers.js';

let server: FastifyInstance;
let clusterId: string;

const utc = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

beforeAll(async () => {
  server = await buildServer({ env: makeTestEnv(), prisma });
});

beforeEach(async () => {
  const cluster = await makeCluster(prisma);
  clusterId = cluster.id;
});

afterAll(async () => {
  await server.close();
});

interface ShiftBody {
  shifted: number;
  items: {
    id: string;
    effectiveDate: string;
    endedAt: string | null;
    allocations: { effectiveFrom: string }[];
  }[];
}

const shift = (payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
  server.inject({ method: 'POST', url: '/api/items/bulk-shift-dates', payload });

const readItem = async (id: string): Promise<ShiftBody['items'][number]> => {
  const response = await server.inject({ method: 'GET', url: `/api/clusters/${clusterId}/items` });
  const body = response.json() as { items: ShiftBody['items'] };
  const found = body.items.find((item) => item.id === id);
  if (!found) throw new Error(`item ${id} not found`);
  return found;
};

describe('POST /api/items/bulk-shift-dates — happy path', () => {
  it('cascades the shift across effectiveDate, every allocation, and endedAt', async () => {
    const app = await makeApplication(prisma, {
      clusterId,
      startedAt: utc('2026-01-15'),
      endedAt: utc('2026-09-30'),
      initialAllocation: [
        { effectiveFrom: utc('2026-01-15'), amount: 64 },
        { effectiveFrom: utc('2026-04-15'), amount: 128 },
      ],
    });

    const response = await shift({ itemIds: [app.id], shift: { amount: 1, unit: 'months' } });

    expect(response.statusCode).toBe(200);
    const body = response.json() as ShiftBody;
    expect(body.shifted).toBe(1);
    expect(body.items[0]).toMatchObject({
      effectiveDate: '2026-02-15',
      endedAt: '2026-10-30',
    });
    expect(body.items[0]?.allocations.map((a) => a.effectiveFrom)).toEqual([
      '2026-02-15',
      '2026-05-15',
    ]);
  });

  it('moves an event by a negative shift (earlier) in days', async () => {
    const event = await makeEvent(prisma, { clusterId, effectiveDate: utc('2026-10-01') });

    const response = await shift({ itemIds: [event.id], shift: { amount: -10, unit: 'days' } });

    expect(response.statusCode).toBe(200);
    expect((response.json() as ShiftBody).items[0]?.effectiveDate).toBe('2026-09-21');
  });

  it('shifts by weeks', async () => {
    const event = await makeEvent(prisma, { clusterId, effectiveDate: utc('2026-10-01') });

    const response = await shift({ itemIds: [event.id], shift: { amount: 2, unit: 'weeks' } });

    expect((response.json() as ShiftBody).items[0]?.effectiveDate).toBe('2026-10-15');
  });

  it('moves a mixed batch of applications and events by one delta', async () => {
    const app = await makeApplication(prisma, { clusterId, startedAt: utc('2026-01-15') });
    const event = await makeEvent(prisma, { clusterId, effectiveDate: utc('2026-03-01') });

    const response = await shift({
      itemIds: [app.id, event.id],
      shift: { amount: 1, unit: 'months' },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as ShiftBody).shifted).toBe(2);
    expect((await readItem(app.id)).effectiveDate).toBe('2026-02-15');
    expect((await readItem(event.id)).effectiveDate).toBe('2026-04-01');
  });

  it('leaves an entry without an end date at endedAt null', async () => {
    const app = await makeApplication(prisma, { clusterId, startedAt: utc('2026-01-15') });

    const response = await shift({ itemIds: [app.id], shift: { amount: 1, unit: 'months' } });

    expect((response.json() as ShiftBody).items[0]?.endedAt).toBeNull();
  });

  it('deduplicates repeated ids so an entry is never shifted twice', async () => {
    const event = await makeEvent(prisma, { clusterId, effectiveDate: utc('2026-10-01') });

    const response = await shift({
      itemIds: [event.id, event.id],
      shift: { amount: 1, unit: 'months' },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as ShiftBody).shifted).toBe(1);
    expect((await readItem(event.id)).effectiveDate).toBe('2026-11-01');
  });

  it('keeps effectiveDate on or before the earliest allocation (the cascade invariant)', async () => {
    const app = await makeApplication(prisma, {
      clusterId,
      startedAt: utc('2026-01-31'),
      initialAllocation: [{ effectiveFrom: utc('2026-01-31'), amount: 64 }],
    });

    // February clamps both dates to the 28th — they must clamp together, never
    // leaving the start after its own first allocation.
    const response = await shift({ itemIds: [app.id], shift: { amount: 1, unit: 'months' } });

    const item = (response.json() as ShiftBody).items[0];
    expect(item?.effectiveDate).toBe('2026-02-28');
    expect(item?.allocations[0]?.effectiveFrom).toBe('2026-02-28');
    expect(
      item?.effectiveDate.localeCompare(item.allocations[0]?.effectiveFrom ?? ''),
    ).toBeLessThanOrEqual(0);
  });

  it('succeeds when a forward shift lands one allocation on another row s old date', async () => {
    // {Jan 1, Feb 1} + 1 month = {Feb 1, Mar 1}. Writing the Jan row first
    // would collide with the not-yet-moved Feb row under the per-statement
    // unique index, so this asserts the update ordering, not just the result.
    const app = await makeApplication(prisma, {
      clusterId,
      startedAt: utc('2026-01-01'),
      initialAllocation: [
        { effectiveFrom: utc('2026-01-01'), amount: 64 },
        { effectiveFrom: utc('2026-02-01'), amount: 128 },
      ],
    });

    const response = await shift({ itemIds: [app.id], shift: { amount: 1, unit: 'months' } });

    expect(response.statusCode).toBe(200);
    expect(
      (response.json() as ShiftBody).items[0]?.allocations.map((a) => a.effectiveFrom),
    ).toEqual(['2026-02-01', '2026-03-01']);
  });

  it('succeeds when a backward shift lands one allocation on another row s old date', async () => {
    const app = await makeApplication(prisma, {
      clusterId,
      startedAt: utc('2026-01-01'),
      initialAllocation: [
        { effectiveFrom: utc('2026-01-01'), amount: 64 },
        { effectiveFrom: utc('2026-02-01'), amount: 128 },
      ],
    });

    const response = await shift({ itemIds: [app.id], shift: { amount: -1, unit: 'months' } });

    expect(response.statusCode).toBe(200);
    expect(
      (response.json() as ShiftBody).items[0]?.allocations.map((a) => a.effectiveFrom),
    ).toEqual(['2025-12-01', '2026-01-01']);
  });
});

describe('POST /api/items/bulk-shift-dates — request validation', () => {
  it('rejects an empty id list', async () => {
    const response = await shift({ itemIds: [], shift: { amount: 1, unit: 'months' } });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a batch larger than the documented cap', async () => {
    const itemIds = Array.from({ length: 101 }, (_, i) => `id-${i}`);
    const response = await shift({ itemIds, shift: { amount: 1, unit: 'months' } });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a zero shift', async () => {
    const event = await makeEvent(prisma, { clusterId });
    const response = await shift({ itemIds: [event.id], shift: { amount: 0, unit: 'months' } });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a non-integer shift', async () => {
    const event = await makeEvent(prisma, { clusterId });
    const response = await shift({ itemIds: [event.id], shift: { amount: 1.5, unit: 'months' } });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a shift beyond the per-unit magnitude cap', async () => {
    const event = await makeEvent(prisma, { clusterId });
    const response = await shift({ itemIds: [event.id], shift: { amount: 121, unit: 'months' } });
    expect(response.statusCode).toBe(400);
  });

  it('rejects an unknown unit', async () => {
    const event = await makeEvent(prisma, { clusterId });
    const response = await shift({ itemIds: [event.id], shift: { amount: 1, unit: 'years' } });
    expect(response.statusCode).toBe(400);
  });

  it('rejects unknown body keys', async () => {
    const event = await makeEvent(prisma, { clusterId });
    const response = await shift({
      itemIds: [event.id],
      shift: { amount: 1, unit: 'months' },
      setTo: '2027-01-01',
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('POST /api/items/bulk-shift-dates — resulting-date validation', () => {
  it('returns 422 when the shift pushes a date past the supported range', async () => {
    const event = await makeEvent(prisma, { clusterId, effectiveDate: utc('2995-01-01') });

    const response = await shift({ itemIds: [event.id], shift: { amount: 120, unit: 'months' } });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('SHIFT_DATE_OUT_OF_RANGE');
  });

  it('returns 422 when month clamping would collapse two allocation rows', async () => {
    const app = await makeApplication(prisma, {
      clusterId,
      startedAt: utc('2026-01-29'),
      initialAllocation: [
        { effectiveFrom: utc('2026-01-29'), amount: 64 },
        { effectiveFrom: utc('2026-01-31'), amount: 128 },
      ],
    });

    // Both land on 2026-02-28, which would violate the allocation unique index
    // and silently destroy a step in the timeline.
    const response = await shift({ itemIds: [app.id], shift: { amount: 1, unit: 'months' } });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('SHIFT_ALLOCATION_COLLISION');
  });

  it('returns 404 when any id in the batch is unknown', async () => {
    const event = await makeEvent(prisma, { clusterId });
    const response = await shift({
      itemIds: [event.id, 'does-not-exist'],
      shift: { amount: 1, unit: 'months' },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /api/items/bulk-shift-dates — atomicity', () => {
  it('leaves every entry untouched when one entry in the batch is invalid', async () => {
    const good = await makeEvent(prisma, { clusterId, effectiveDate: utc('2026-10-01') });
    const bad = await makeApplication(prisma, {
      clusterId,
      startedAt: utc('2026-01-29'),
      initialAllocation: [
        { effectiveFrom: utc('2026-01-29'), amount: 64 },
        { effectiveFrom: utc('2026-01-31'), amount: 128 },
      ],
    });

    const response = await shift({
      itemIds: [good.id, bad.id],
      shift: { amount: 1, unit: 'months' },
    });

    expect(response.statusCode).toBe(422);
    expect((await readItem(good.id)).effectiveDate).toBe('2026-10-01');
    const untouched = await readItem(bad.id);
    expect(untouched.effectiveDate).toBe('2026-01-29');
    expect(untouched.allocations.map((a) => a.effectiveFrom)).toEqual(['2026-01-29', '2026-01-31']);
  });

  it('leaves every entry untouched when one id in the batch is unknown', async () => {
    const good = await makeEvent(prisma, { clusterId, effectiveDate: utc('2026-10-01') });

    const response = await shift({
      itemIds: [good.id, 'does-not-exist'],
      shift: { amount: 1, unit: 'months' },
    });

    expect(response.statusCode).toBe(404);
    expect((await readItem(good.id)).effectiveDate).toBe('2026-10-01');
  });
});

describe('POST /api/items/bulk-shift-dates — RBAC', () => {
  const CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  const authServers: FastifyInstance[] = [];

  afterAll(async () => {
    await Promise.all(authServers.map((instance) => instance.close()));
  });

  async function sessionForRole(role: 'ADMIN' | 'VIEWER'): Promise<string> {
    const user = await prisma.user.create({
      data: {
        issuer: 'https://idp.test',
        subject: `bulk-shift-${role}-${Math.random().toString(36).slice(2)}`,
        email: `${role.toLowerCase()}@example.com`,
        role,
      },
    });
    const { token } = await new SessionService(prisma).create(user.id, 12);
    return token;
  }

  async function authServer(): Promise<FastifyInstance> {
    const instance = await buildServer({
      env: makeOidcTestEnv({ CONFIG_ENCRYPTION_KEY }),
      prisma,
    });
    authServers.push(instance);
    return instance;
  }

  it('returns 403 FORBIDDEN for a VIEWER and does not move the dates', async () => {
    const event = await makeEvent(prisma, { clusterId, effectiveDate: utc('2026-10-01') });
    const token = await sessionForRole('VIEWER');
    const instance = await authServer();

    const response = await instance.inject({
      method: 'POST',
      url: '/api/items/bulk-shift-dates',
      cookies: { [SESSION_COOKIE]: token },
      payload: { itemIds: [event.id], shift: { amount: 1, unit: 'months' } },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
    expect((await readItem(event.id)).effectiveDate).toBe('2026-10-01');
  });

  it('allows an ADMIN through the same gate', async () => {
    const event = await makeEvent(prisma, { clusterId, effectiveDate: utc('2026-10-01') });
    const token = await sessionForRole('ADMIN');
    const instance = await authServer();

    const response = await instance.inject({
      method: 'POST',
      url: '/api/items/bulk-shift-dates',
      cookies: { [SESSION_COOKIE]: token },
      payload: { itemIds: [event.id], shift: { amount: 1, unit: 'months' } },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as ShiftBody).items[0]?.effectiveDate).toBe('2026-11-01');
  });
});
