import { expect, test } from '@playwright/test';

import { assertShellContainsScroll } from '../playwright/support/scroll-containment';

/**
 * The scroll-containment invariant (see support/scroll-containment) is
 * auth-mode-agnostic, but the smoke suite that exercises it in AUTH_MODE=disabled
 * does not run in CI. This OIDC suite is the browser-level e2e that CI runs, so
 * verify the invariant here too — post-login, on the real app shell.
 */
test.describe('app-shell scroll containment (authenticated)', () => {
  test('document does not scroll; topbar stays pinned while main scrolls', async ({ page }) => {
    // Reuse the mock-IdP auto-approve login the OIDC auth spec relies on.
    await page.goto('/');
    await page.getByRole('link', { name: /sign in/i }).click();
    await expect(page).toHaveURL('http://localhost:5174/');

    await assertShellContainsScroll(page);
  });
});
