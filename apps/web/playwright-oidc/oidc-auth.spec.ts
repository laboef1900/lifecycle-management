import { expect, test } from '@playwright/test';

/**
 * Full browser-level OIDC round trip against a mock IdP that auto-approves the
 * authorize request (see apps/server/scripts/e2e-oidc-server.ts): an
 * unauthenticated visit is bounced to /login, "Sign in" round-trips through the
 * IdP and returns authenticated, and "Sign out" clears the session.
 */
test.describe('OIDC authentication (browser-level)', () => {
  test('signs in through the IdP, reaches a protected page, and signs out', async ({ page }) => {
    // Unauthenticated → bounced to the login page.
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    const signIn = page.getByRole('link', { name: /sign in/i });
    await expect(signIn).toBeVisible();

    // The mock IdP auto-approves, so this single click round-trips back signed in.
    await signIn.click();

    // Back on a protected page (the dashboard), with the account menu present.
    await expect(page).toHaveURL('http://localhost:5174/');
    const accountMenu = page.getByRole('button', { name: 'Account menu' });
    await expect(accountMenu).toBeVisible();

    // The JIT-provisioned identity from the IdP token is reflected in the menu.
    await accountMenu.click();
    await expect(page.getByText('ada@example.com')).toBeVisible();

    // Sign out returns to the login page and clears the session.
    await page.getByRole('menuitem', { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('link', { name: /sign in/i })).toBeVisible();
  });
});
