import { expect, test } from '@playwright/test';

const API_BASE = 'http://localhost:8090';

const suffix = (): string =>
  `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

/**
 * `authConfigUpdateSchema` is a `strictObject` with no partial-update support
 * (an omitted `mode` isn't merged server-side — the whole shape must be
 * resent), so both the enable and the reset PUT below repeat this base.
 */
const AUTH_CONFIG_BASE = {
  scopes: 'openid profile email',
  defaultRole: 'admin' as const,
  sessionTtlHours: 12,
  allowInsecure: false,
};

/**
 * Golden path for local-mode login:
 *   1. Create a local admin via the API while auth is still `disabled` (the
 *      `/api/settings/auth*` gate is wide open in that mode — see the
 *      `preHandler` in `settings-auth.ts`).
 *   2. Switch auth mode to `local`.
 *   3. Drive the `/login` form and confirm it lands back on the dashboard.
 *
 * Cleanup is the tricky part: once mode is `local`, `/api/settings/auth*`
 * requires an authenticated ADMIN, so the plain `request` context used for
 * setup can no longer flip things back on its own. `finally` re-authenticates
 * as the admin we just created via `POST /api/auth/local/login` — this is
 * independent of whatever the browser did, so cleanup still works even if the
 * UI login itself never completed — then reuses that session to reset mode
 * to `disabled` and delete the local admin (`removeGuarded` refuses to strip
 * the last enabled local admin while mode is still `local`, so the reset
 * must happen first). Every cleanup step is best-effort and swallows its own
 * errors: a cleanup hiccup must never overwrite the pass/fail verdict the
 * test body above already produced.
 */
test('local admin can sign in and reach the dashboard', async ({ page, request }) => {
  const username = `e2e-admin-${suffix()}`;
  const password = 'twelvecharsok!';
  let userId: string | null = null;

  try {
    const createResp = await request.post(`${API_BASE}/api/settings/auth/local-users`, {
      data: { username, password, role: 'ADMIN' },
    });
    expect(createResp.ok()).toBe(true);
    const created = (await createResp.json()) as { id: string };
    userId = created.id;

    const enableResp = await request.put(`${API_BASE}/api/settings/auth`, {
      data: { mode: 'local', ...AUTH_CONFIG_BASE },
    });
    expect(enableResp.ok()).toBe(true);

    await page.goto('/login');
    await page.getByLabel(/username/i).fill(username);
    await page.getByLabel(/password/i).fill(password);
    await page.getByRole('button', { name: /sign in/i }).click();

    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { name: 'Fleet', level: 1 })).toBeVisible();
  } finally {
    try {
      // Best-effort re-auth: independent of the UI, so this still runs even
      // if the browser login step above failed or never ran.
      await request.post(`${API_BASE}/api/auth/local/login`, { data: { username, password } });

      const disableResp = await request.put(`${API_BASE}/api/settings/auth`, {
        data: { mode: 'disabled', ...AUTH_CONFIG_BASE },
      });
      if (!disableResp.ok()) {
        console.error(
          `local-login cleanup: failed to reset auth mode to disabled (${disableResp.status()})`,
        );
      }

      if (userId) {
        const deleteResp = await request.delete(
          `${API_BASE}/api/settings/auth/local-users/${userId}`,
        );
        if (!deleteResp.ok() && deleteResp.status() !== 404) {
          console.error(
            `local-login cleanup: failed to delete local admin ${userId} (${deleteResp.status()})`,
          );
        }
      }
    } catch (err) {
      console.error('local-login cleanup: unexpected error while resetting auth state', err);
    }
  }
});
