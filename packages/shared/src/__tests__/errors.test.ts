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

  it('carries BASELINE_PERIOD_OCCUPIED (a date-only baseline edit onto a taken period)', () => {
    // A date-only edit re-dates each metric's newest history row (#195). When the
    // target period already holds a recorded measurement, honouring the edit would
    // have to destroy an append-only row, so the request is refused instead. The
    // baseline form needs a distinct code rather than a generic failure, because
    // the corrective action is specific: submit the values for that period, which
    // corrects the recorded measurement in place rather than moving a row onto it.
    // (The message used to say "edit that period directly instead", which named no
    // operation the API offered — a value-carrying edit onto an occupied period was
    // itself refused. That is fixed, so the advice is now executable.)
    expect(SERVICE_ERROR_CODES).toContain('BASELINE_PERIOD_OCCUPIED');
  });

  it('carries BASELINE_PERIOD_NOT_MEASURED (a date-only edit dragged FORWARD)', () => {
    // The other direction of the same edit (#195). A date-only PUT carries no
    // values, so the only way to honour a LATER period would be to re-date a
    // measurement onto a month nobody measured — which lets the row shadow the
    // real snapshot for that period and clears staleness without measuring
    // anything. There is nothing honest to write, so it is refused; the corrective
    // action differs from BASELINE_PERIOD_OCCUPIED (submit the values), so the
    // code has to differ too.
    //
    // A third consequence used to be listed first here and is GONE: "it absorbs
    // deltas that started after the capture". That was true while absorption keyed
    // off `captured_at`; it keys off `observed_at`, which no edit path writes, so a
    // re-date changes no absorption at all. clusters.ts records the same removal at
    // the refusal itself — the code exists on the two surviving grounds.
    //
    // The same code also answers a date-only edit on a cluster with NO history,
    // where there is likewise no measurement to re-date.
    expect(SERVICE_ERROR_CODES).toContain('BASELINE_PERIOD_NOT_MEASURED');
  });

  it('carries OIDC_MODE_REQUIRED (signing-secret rotation refused outside oidc mode)', () => {
    // The login-state signing secret only signs OIDC login-state cookies, and
    // saving a non-oidc mode clears both secret columns (#241). Rotating one
    // onto a `disabled`/`local` row would store a secret nothing reads, so the
    // route refuses with its own code rather than a generic 422.
    expect(SERVICE_ERROR_CODES).toContain('OIDC_MODE_REQUIRED');
  });

  it('carries CLIENT_SECRET_NOT_APPLICABLE (a client secret submitted with a non-oidc mode)', () => {
    // Saving a non-oidc mode clears both secret columns (#241), so a client
    // secret sent alongside one could only ever be dropped. The write is
    // refused rather than silently discarded, and the web client branches on
    // this code to tell the operator to clear the field.
    expect(SERVICE_ERROR_CODES).toContain('CLIENT_SECRET_NOT_APPLICABLE');
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
