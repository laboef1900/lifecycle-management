import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchAuthState } from '@/lib/auth';

function mockFetchOnce(response: Partial<Response> & { json?: () => Promise<unknown> }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({}), ...response }),
  );
}

describe('fetchAuthState', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the parsed payload for a valid response', async () => {
    mockFetchOnce({ json: async () => ({ authRequired: false }) });
    expect(await fetchAuthState()).toEqual({ authRequired: false });
  });

  it('falls back to authRequired=true on HTTP errors, bad shapes, and network failures', async () => {
    mockFetchOnce({ ok: false });
    expect(await fetchAuthState()).toEqual({ authRequired: true });

    mockFetchOnce({ json: async () => ({ nonsense: 1 }) });
    expect(await fetchAuthState()).toEqual({ authRequired: true });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    expect(await fetchAuthState()).toEqual({ authRequired: true });
  });
});
