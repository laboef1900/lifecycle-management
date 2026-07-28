import { expect, test } from '@playwright/test';

import { assertShellContainsScroll } from '../playwright/support/scroll-containment';

/**
 * The scroll-containment invariant (see support/scroll-containment) is
 * auth-mode-agnostic, but the smoke suite that exercises it in AUTH_MODE=disabled
 * only runs on the `dev → main` sync PR (the `golden-path-e2e` job, #334). This
 * OIDC suite runs on *every* PR, so keep verifying the invariant here too —
 * post-login, on the real app shell — rather than deferring it to promotion.
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
