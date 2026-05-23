import { useCallback, useEffect, useMemo, useState } from 'react';

import { ThemeContext, type ResolvedTheme, type Theme } from './use-theme';

const STORAGE_KEY = 'theme';

function readStoredTheme(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'light' || value === 'dark' || value === 'system') return value;
  } catch {
    // localStorage may throw in private modes; fall through to default
  }
  return 'system';
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyResolved(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  if (resolved === 'dark') document.documentElement.classList.add('dark');
  else document.documentElement.classList.remove('dark');
}

interface ThemeProviderProps {
  children: React.ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps): React.JSX.Element {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => getSystemTheme());

  // Subscribe to OS-level preference changes.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (event: MediaQueryListEvent): void => {
      setSystemTheme(event.matches ? 'dark' : 'light');
    };
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }, []);

  const resolvedTheme: ResolvedTheme = theme === 'system' ? systemTheme : theme;

  // Apply the resolved theme to <html>.
  useEffect(() => {
    applyResolved(resolvedTheme);
  }, [resolvedTheme]);

  const setTheme = useCallback((next: Theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore — feature degrades to non-persistent
    }
    setThemeState(next);
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
