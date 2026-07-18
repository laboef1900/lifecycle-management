import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

const wellFormedAuthConfigResponse = {
  mode: 'oidc',
  forceDisabledReason: null,
  issuerUrl: 'https://idp.example.com',
  clientId: 'client-123',
  appBaseUrl: 'https://app.example.com',
  scopes: 'openid profile email',
  roleClaim: 'roles',
  adminValues: 'admin',
  defaultRole: 'admin',
  allowedEmailDomains: 'example.com',
  allowedEmails: null,
  sessionTtlHours: 12,
  allowInsecure: false,
  clientSecretSet: true,
  signingSecretSet: true,
  redirectUri: 'https://app.example.com/auth/callback',
  discoveryStatus: 'connected',
  lastDiscoveryError: null,
};

describe('api.settings.auth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('get() validates a well-formed response through authConfigResponseSchema', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(wellFormedAuthConfigResponse)));

    const result = await api.settings.auth.get();
    expect(result).toEqual(wellFormedAuthConfigResponse);
  });

  it('get() throws RESPONSE_VALIDATION when discoveryStatus is not one of the allowed enum values', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          ...wellFormedAuthConfigResponse,
          discoveryStatus: 'bogus',
        }),
      ),
    );

    await expect(api.settings.auth.get()).rejects.toMatchObject({ code: 'RESPONSE_VALIDATION' });
  });

  it('get() throws RESPONSE_VALIDATION when a required field is missing', async () => {
    const { mode: _mode, ...missingMode } = wellFormedAuthConfigResponse;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(missingMode)));

    await expect(api.settings.auth.get()).rejects.toMatchObject({ code: 'RESPONSE_VALIDATION' });
  });

  it('update() sends a PUT with the body and validates the response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ...wellFormedAuthConfigResponse, mode: 'disabled' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.settings.auth.update({
      mode: 'disabled',
      issuerUrl: null,
      clientId: null,
      clientSecret: null,
      appBaseUrl: null,
      scopes: 'openid profile email',
      roleClaim: null,
      adminValues: null,
      defaultRole: 'admin',
      allowedEmailDomains: null,
      allowedEmails: null,
      sessionTtlHours: 12,
      allowInsecure: false,
    });

    expect(result.mode).toBe('disabled');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/auth',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('test() posts to /api/settings/auth/test and returns the small typed result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, error: null }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.settings.auth.test({
      issuerUrl: 'https://idp.example.com',
      clientId: 'client-123',
      clientSecret: null,
      allowInsecure: false,
    });

    expect(result).toEqual({ ok: true, error: null });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/auth/test',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('rotateSigningSecret() posts and returns { rotated: true }', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ rotated: true }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.settings.auth.rotateSigningSecret();

    expect(result).toEqual({ rotated: true });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/auth/rotate-signing-secret',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
