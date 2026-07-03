import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

describe('api-client 401 handling', () => {
  const assignMock = vi.fn();
  let originalLocation: Location;

  beforeEach(() => {
    originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, pathname: '/', assign: assignMock },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    vi.unstubAllGlobals();
    assignMock.mockReset();
  });

  it('redirects to /login on a 401 and still throws the ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () =>
          JSON.stringify({
            error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
          }),
      }),
    );

    await expect(api.clusters.list()).rejects.toMatchObject({ status: 401 });
    expect(assignMock).toHaveBeenCalledWith('/login');
  });

  it('does not redirect when already on /login', async () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, pathname: '/login', assign: assignMock },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => '' }),
    );

    await expect(api.clusters.list()).rejects.toMatchObject({ status: 401 });
    expect(assignMock).not.toHaveBeenCalled();
  });

  it('sends same-origin credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal('fetch', fetchMock);

    await api.hostReplacements.delete('x');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/host-replacements/x',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });
});
