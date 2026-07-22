import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ThemeContext, type ThemeContextValue } from './use-theme';

import { ThemeToggle } from './theme-toggle';

function renderToggle(overrides: Partial<ThemeContextValue> = {}): {
  setTheme: ReturnType<typeof vi.fn>;
} {
  const setTheme = vi.fn();
  const value: ThemeContextValue = {
    theme: 'system',
    resolvedTheme: 'dark',
    setTheme,
    ...overrides,
  };
  render(
    <ThemeContext.Provider value={value}>
      <ThemeToggle />
    </ThemeContext.Provider>,
  );
  return { setTheme };
}

describe('<ThemeToggle> (#243 Part B copy item 3)', () => {
  it('names the action, not just the current state', () => {
    // Previously "Theme: System" — a screen-reader user heard what IS set,
    // not what activating the button does.
    renderToggle({ theme: 'system' });
    const button = screen.getByRole('button', { name: /switch theme/i });
    expect(button).toHaveAccessibleName('Switch theme (current: system)');
  });

  it('reflects each theme in both the accessible name and the title tooltip', () => {
    for (const theme of ['system', 'light', 'dark'] as const) {
      const { unmount } = render(
        <ThemeContext.Provider
          value={{ theme, resolvedTheme: theme === 'dark' ? 'dark' : 'light', setTheme: vi.fn() }}
        >
          <ThemeToggle />
        </ThemeContext.Provider>,
      );
      const button = screen.getByRole('button');
      expect(button).toHaveAccessibleName(`Switch theme (current: ${theme})`);
      expect(button).toHaveAttribute('title', `Switch theme (current: ${theme})`);
      unmount();
    }
  });

  it('cycles system -> light -> dark on click, unchanged from before', async () => {
    const user = userEvent.setup();
    const { setTheme } = renderToggle({ theme: 'light' });

    await user.click(screen.getByRole('button'));

    expect(setTheme).toHaveBeenCalledWith('dark');
  });
});
