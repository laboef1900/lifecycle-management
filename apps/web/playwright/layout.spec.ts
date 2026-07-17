import { test } from '@playwright/test';

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
