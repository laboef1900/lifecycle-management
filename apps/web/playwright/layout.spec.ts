import { expect, test } from '@playwright/test';

import { assertShellContainsScroll } from './support/scroll-containment';

// Desktop app-shell (>= lg) must contain vertical scrolling to <main>: the
// document itself must never scroll, so the topbar stays pinned. Regression
// guard for the bug where the shell used `min-h-screen` and <main> only
// carried an implicit overflow, letting the whole document — and the chrome
// with it — scroll. Post-mission-bento-redesign: the pinned landmark is the
// topbar nav (the sidebar/aside is gone — see support/scroll-containment).
test.describe('desktop app-shell scroll containment', () => {
  test('document does not scroll; topbar stays pinned while main scrolls', async ({ page }) => {
    await page.goto('/');
    await assertShellContainsScroll(page);
  });
});

// `/clusters` was the old Clusters-page route; the fleet console merge (spec
// §4) retired it in favor of `/` (the console now covers both former pages).
// The route's `beforeLoad` throws a redirect to `/` — regression guard for
// that contract (spec §2).
test.describe('/clusters redirect', () => {
  test('redirects to / (retired route from the pre-merge Clusters page)', async ({ page }) => {
    await page.goto('/clusters');
    await expect(page).toHaveURL('/');
  });
});
