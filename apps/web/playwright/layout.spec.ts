import { expect, test } from '@playwright/test';

// Desktop app-shell (>= lg) must contain vertical scrolling to <main>: the
// document itself must never scroll, so the header and sidebar stay pinned.
// Regression guard for the bug where the shell used `min-h-screen` and <main>
// only carried an *implicit* overflow (from `overflow-x-hidden`), which let the
// whole document — and the sidebar with it — scroll.
test.describe('desktop app-shell scroll containment', () => {
  // Short, wide viewport: wide enough for the lg sidebar, short enough that the
  // overview content overflows and something must scroll.
  test.use({ viewport: { width: 1280, height: 600 } });

  test('document does not scroll; sidebar stays pinned while main scrolls', async ({ page }) => {
    await page.goto('/');

    // Desktop sidebar renders at lg+ with aria-label "Primary navigation".
    await expect(page.getByLabel('Primary navigation')).toBeVisible();
    // Wait for overview content so the page is genuinely taller than 600px.
    await expect(page.locator('main a[href^="/clusters/"]').first()).toBeVisible();

    const r = await page.evaluate(() => {
      const aside = document.querySelector<HTMLElement>('aside[aria-label="Primary navigation"]')!;
      const main = document.querySelector<HTMLElement>('main')!;
      const asideTopBefore = Math.round(aside.getBoundingClientRect().top);

      // The document must not be scrollable.
      window.scrollTo(0, 10_000);
      const docScrollY = Math.round(window.scrollY);
      const asideTopAfterDocScroll = Math.round(aside.getBoundingClientRect().top);
      window.scrollTo(0, 0);

      // <main> is the single scroll container; overflowing content lives there.
      main.scrollTop = 10_000;
      const mainScrolled = main.scrollTop > 0;
      main.scrollTop = 0;

      return { docScrollY, asideTopBefore, asideTopAfterDocScroll, mainScrolled };
    });

    expect(r.docScrollY).toBe(0); // the document never scrolls
    expect(r.asideTopAfterDocScroll).toBe(r.asideTopBefore); // sidebar stays pinned
    expect(r.mainScrolled).toBe(true); // overflowing content is reachable via main
  });
});
