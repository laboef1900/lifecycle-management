import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ThemeProvider } from '@/components/theme/theme-provider';
import { useTheme } from '@/components/theme/use-theme';

interface MediaQueryListenerSet {
  matches: boolean;
  listener: ((event: MediaQueryListEvent) => void) | null;
}

function stubMatchMedia(initial: boolean): MediaQueryListenerSet {
  const state: MediaQueryListenerSet = { matches: initial, listener: null };
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: state.matches,
      media: query,
      onchange: null,
      addEventListener: (_event: string, cb: (e: MediaQueryListEvent) => void) => {
        state.listener = cb;
      },
      removeEventListener: () => {
        state.listener = null;
      },
      dispatchEvent: () => false,
    })),
  );
  return state;
}

function Probe(): React.JSX.Element {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <button onClick={() => setTheme('dark')}>set-dark</button>
      <button onClick={() => setTheme('light')}>set-light</button>
      <button onClick={() => setTheme('system')}>set-system</button>
    </div>
  );
}

describe('useTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('defaults to system, resolves to light when OS prefers light', () => {
    stubMatchMedia(false);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('system');
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  test('defaults to system, resolves to dark when OS prefers dark', () => {
    stubMatchMedia(true);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  test('reads persisted theme from localStorage on mount', () => {
    localStorage.setItem('theme', 'dark');
    stubMatchMedia(false);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  test('setTheme(light) persists and removes dark class', async () => {
    const user = userEvent.setup();
    stubMatchMedia(true);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    await user.click(screen.getByText('set-light'));
    expect(localStorage.getItem('theme')).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  test('system mode tracks OS changes live', () => {
    const media = stubMatchMedia(false);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');
    act(() => {
      media.matches = true;
      media.listener?.({ matches: true } as MediaQueryListEvent);
    });
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
  });
});
