import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../server.js';

import { makeApplication, makeCluster } from './factories.js';
import { prisma } from './setup.js';
import { makeTestEnv } from './test-helpers.js';

let server: FastifyInstance;
let clusterId: string;

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

const utc = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const shift = (
  payload: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<LightMyRequestResponse> =>
  server.inject({
    method: 'POST',
    url: '/api/items/bulk-shift-dates',
    payload,
    headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
  });

describe('POST /api/items/bulk-shift-dates — idempotency', () => {
  it('rejects a request with no Idempotency-Key header', async () => {
    const app = await makeApplication(prisma, { clusterId, startedAt: utc('2026-01-15') });
    const response = await shift({ itemIds: [app.id], shift: { amount: 1, unit: 'months' } });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a malformed Idempotency-Key header', async () => {
    const app = await makeApplication(prisma, { clusterId, startedAt: utc('2026-01-15') });
    const response = await shift(
      { itemIds: [app.id], shift: { amount: 1, unit: 'months' } },
      'not-a-uuid',
    );
    expect(response.statusCode).toBe(400);
  });

  it('a replay with the identical payload returns the original response and does not shift again', async () => {
    const app = await makeApplication(prisma, { clusterId, startedAt: utc('2026-01-15') });
    const key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const payload = { itemIds: [app.id], shift: { amount: 1, unit: 'months' } };

    const first = await shift(payload, key);
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();

    const second = await shift(payload, key);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(firstBody);

    const row = await prisma.item.findUniqueOrThrow({ where: { id: app.id } });
    expect(row.effectiveDate.toISOString().slice(0, 10)).toBe('2026-02-15');
  });

  it('the same key with a different payload is rejected as a conflict, not executed', async () => {
    const app = await makeApplication(prisma, { clusterId, startedAt: utc('2026-01-15') });
    const key = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    const first = await shift({ itemIds: [app.id], shift: { amount: 1, unit: 'months' } }, key);
    expect(first.statusCode).toBe(200);

    const second = await shift({ itemIds: [app.id], shift: { amount: 2, unit: 'months' } }, key);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');

    // The conflicting request must not have applied its own delta on top.
    const row = await prisma.item.findUniqueOrThrow({ where: { id: app.id } });
    expect(row.effectiveDate.toISOString().slice(0, 10)).toBe('2026-02-15');
  });

  it('treats reordered itemIds naming the same set as the same request', async () => {
    const appA = await makeApplication(prisma, { clusterId, startedAt: utc('2026-01-15') });
    const appB = await makeApplication(prisma, { clusterId, startedAt: utc('2026-01-20') });
    const key = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    const first = await shift(
      { itemIds: [appA.id, appB.id], shift: { amount: 1, unit: 'months' } },
      key,
    );
    expect(first.statusCode).toBe(200);

    // Same logical request, items named in the opposite order.
    const second = await shift(
      { itemIds: [appB.id, appA.id], shift: { amount: 1, unit: 'months' } },
      key,
    );
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
  });

  it('a genuinely failed request (unknown item) retried under the same key still succeeds', async () => {
    const app = await makeApplication(prisma, { clusterId, startedAt: utc('2026-01-15') });
    const key = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

    const failing = await shift(
      { itemIds: [app.id, 'does-not-exist'], shift: { amount: 1, unit: 'months' } },
      key,
    );
    expect(failing.statusCode).toBe(404);

    const retry = await shift({ itemIds: [app.id], shift: { amount: 1, unit: 'months' } }, key);
    expect(retry.statusCode).toBe(200);

    const row = await prisma.item.findUniqueOrThrow({ where: { id: app.id } });
    expect(row.effectiveDate.toISOString().slice(0, 10)).toBe('2026-02-15');
  });

  it('concurrent duplicate submissions under the same key apply the shift exactly once', async () => {
    const app = await makeApplication(prisma, { clusterId, startedAt: utc('2026-01-15') });
    const key = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const payload = { itemIds: [app.id], shift: { amount: 1, unit: 'months' } };

    const [a, b] = await Promise.all([shift(payload, key), shift(payload, key)]);
    const statuses = [a.statusCode, b.statusCode].sort();
    // One committed (200); the loser hits a serialization conflict. Per the
    // existing @ai-note on bulkShiftDates, that conflict is NOT translated to
    // a friendly code here and surfaces as a sanitized 500 — accepted
    // behaviour, unchanged by this feature.
    expect(statuses).toEqual([200, 500]);

    const row = await prisma.item.findUniqueOrThrow({ where: { id: app.id } });
    // Exactly one month, not two — the whole point of the test.
    expect(row.effectiveDate.toISOString().slice(0, 10)).toBe('2026-02-15');
  });
});
