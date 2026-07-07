import { test } from '@playwright/test';

import { assertShellContainsScroll } from './support/scroll-containment';

// Desktop app-shell (>= lg) must contain vertical scrolling to <main>: the
// document itself must never scroll, so the header and sidebar stay pinned.
// Regression guard for the bug where the shell used `min-h-screen` and <main>
// only carried an implicit overflow, letting the whole document — and the
// sidebar with it — scroll.
test.describe('desktop app-shell scroll containment', () => {
  test('document does not scroll; sidebar stays pinned while main scrolls', async ({ page }) => {
    await page.goto('/');
    await assertShellContainsScroll(page);
  });
});
