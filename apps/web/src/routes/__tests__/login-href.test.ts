import { describe, expect, it } from 'vitest';

import { buildLoginHref } from '@/routes/login';

describe('buildLoginHref', () => {
  it('returns the bare login URL when there is no redirect', () => {
    expect(buildLoginHref(undefined)).toBe('/api/auth/login');
  });

  it('forwards and URL-encodes the redirect target', () => {
    expect(buildLoginHref('/clusters/abc?tab=hosts')).toBe(
      '/api/auth/login?redirect=%2Fclusters%2Fabc%3Ftab%3Dhosts',
    );
  });
});
