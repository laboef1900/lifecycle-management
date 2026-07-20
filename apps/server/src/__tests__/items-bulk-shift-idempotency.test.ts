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
    // The winner always commits (200). The loser's outcome depends on timing:
    // if its transaction starts before the winner commits, it collides and
    // hits a genuine Postgres serialization conflict — per the existing
    // @ai-note on bulkShiftDates, that is NOT translated to a friendly code
    // here and surfaces as a sanitized 500 (accepted behaviour, unchanged by
    // this feature). If it starts late enough to see the winner's already-
    // committed idempotency-key row, it instead gets a legitimate 200 cache
    // hit — also correct, and NOT a bug: this is `record()` reading
    // tenant_settings (a fix for #263) rather than upserting it, which
    // narrows the transaction and makes the cache-hit outcome more likely
    // than before. Both outcomes are safe; assert on the invariant that
    // actually matters (exactly one shift applied) rather than which of the
    // two safe races happened to win.
    expect(statuses.every((s) => s === 200 || s === 500)).toBe(true);
    expect(statuses).toContain(200);

    const row = await prisma.item.findUniqueOrThrow({ where: { id: app.id } });
    // Exactly one month, not two — the whole point of the test.
    expect(row.effectiveDate.toISOString().slice(0, 10)).toBe('2026-02-15');
  });

  it('two concurrent bulk shifts on disjoint item sets do not contend on tenant_settings', async () => {
    // Regression test for the fix to IdempotencyService.record: it used to
    // upsert tenant_settings (a write) on every call, which took a row lock
    // on the shared singleton row inside this Serializable transaction. Two
    // completely unrelated bulk shifts — different clusters, different
    // items, different Idempotency-Key values — would then contend on that
    // one row and could abort each other with a serialization conflict, even
    // though neither transaction touches any data the other one reads or
    // writes. After the fix, record() only reads tenant_settings.
    //
    // What this test does NOT assert: that both requests always return 200.
    // Verified by direct probing (concurrent bulkShiftDates calls against a
    // freshly-seeded Testcontainers Postgres, both before and after this
    // fix, with items on maximally-separated primary keys and with the
    // `items`/`item_allocations` tables pre-padded with hundreds of rows):
    // Postgres's own Serializable Snapshot Isolation takes predicate locks
    // at page (not row) granularity, and a nearly-empty test table has every
    // row on the same handful of physical pages regardless of key value or
    // insertion order — so two *any* concurrent bulk-shifts, even on wholly
    // disjoint items, can still hit a genuine 40001 from that table alone.
    // That is pre-existing, accepted behaviour (see the `@ai-note` above
    // `bulkShiftDates`: a serialization conflict is deliberately surfaced as
    // a sanitized 500, not retried) and this fix cannot and does not change
    // it — it only removes the ADDITIONAL, guaranteed-every-time contention
    // that came from unconditionally writing the tenant_settings singleton.
    // So the reliable, deterministic signal for this fix is that
    // tenant_settings.updatedAt is untouched by either request — not the
    // pair's status codes, which remain a real Postgres SSI conflict away
    // from either racing outcome.
    const settingsBefore = await prisma.tenantSettings.upsert({
      where: { tenantId: 'default' },
      create: { tenantId: 'default' },
      update: {},
    });

    const clusterA = await makeCluster(prisma);
    const clusterB = await makeCluster(prisma);
    const appA = await makeApplication(prisma, {
      clusterId: clusterA.id,
      startedAt: utc('2026-01-15'),
    });
    const appB = await makeApplication(prisma, {
      clusterId: clusterB.id,
      startedAt: utc('2026-03-10'),
    });

    const [a, b] = await Promise.all([
      shift(
        { itemIds: [appA.id], shift: { amount: 1, unit: 'months' } },
        'ffffffff-ffff-4fff-8fff-ffffffffffff',
      ),
      shift(
        { itemIds: [appB.id], shift: { amount: 2, unit: 'months' } },
        'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1',
      ),
    ]);

    // At least one request must complete; a genuine, pre-existing 40001 from
    // the (unrelated) items-table predicate lock may still abort the other.
    expect([a.statusCode, b.statusCode]).toContain(200);
    expect([a.statusCode, b.statusCode].every((s) => s === 200 || s === 500)).toBe(true);

    // The fix under test: record() must never write tenant_settings, so its
    // @updatedAt column is untouched no matter how the race above resolved.
    const settingsAfter = await prisma.tenantSettings.findUniqueOrThrow({
      where: { tenantId: 'default' },
    });
    expect(settingsAfter.updatedAt.getTime()).toBe(settingsBefore.updatedAt.getTime());
  });
});
