import { Monitor, Moon, Sun } from 'lucide-react';

import { Button } from '@/components/ui/button';

import { useTheme, type Theme } from './use-theme';

const ORDER: Theme[] = ['system', 'light', 'dark'];

function nextTheme(current: Theme): Theme {
  const idx = ORDER.indexOf(current);
  return ORDER[(idx + 1) % ORDER.length] ?? 'system';
}

function labelFor(theme: Theme): string {
  switch (theme) {
    case 'system':
      return 'Theme: System';
    case 'light':
      return 'Theme: Light';
    case 'dark':
      return 'Theme: Dark';
  }
}

export function ThemeToggle(): React.JSX.Element {
  const { theme, setTheme } = useTheme();
  const Icon = theme === 'system' ? Monitor : theme === 'light' ? Sun : Moon;

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={labelFor(theme)}
      title={labelFor(theme)}
      onClick={() => setTheme(nextTheme(theme))}
    >
      <Icon className="h-4 w-4" />
    </Button>
  );
}
