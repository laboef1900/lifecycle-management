import { describe, expect, it } from 'vitest';

import { SERVICE_ERROR_CODES } from '../errors.js';

describe('SERVICE_ERROR_CODES', () => {
  it('carries SYNC_OWNED_FIELD (a synced entity refusing an edit to a sync-owned field)', () => {
    // Synced clusters and hosts keep their label, description, thresholds and
    // lifecycle metadata operator-owned, but reject edits to what vCenter owns
    // (host membership, memory capacity). That refusal needs a code the web
    // client can branch on rather than a generic 400.
    expect(SERVICE_ERROR_CODES).toContain('SYNC_OWNED_FIELD');
  });

  it('carries CONNECTION_DISABLED (Sync now refused on a disabled connection)', () => {
    // "Sync now" (#192) refuses a disabled connection: the scheduler filters
    // disabled connections out, so a queued run could never fire. The web client
    // branches on this code rather than a generic 422.
    expect(SERVICE_ERROR_CODES).toContain('CONNECTION_DISABLED');
  });

  it('contains no duplicate codes', () => {
    // TS will never catch this. The array is `as const` and NOT sorted, so a
    // second copy of an existing literal is legal TypeScript that the derived
    // `ServiceErrorCode` union silently dedupes — leaving two teammates each
    // believing they own the code. With six teammates appending during the
    // vSphere epic, this one assertion is the only thing watching.
    expect(new Set(SERVICE_ERROR_CODES).size).toBe(SERVICE_ERROR_CODES.length);
  });
});
