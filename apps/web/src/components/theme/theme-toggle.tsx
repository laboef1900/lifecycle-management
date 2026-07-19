import { Monitor, Moon, Sun } from 'lucide-react';

import { Button } from '@/components/ui/button';

import { useTheme, type Theme } from './use-theme';

const ORDER: Theme[] = ['system', 'light', 'dark'];

function nextTheme(current: Theme): Theme {
  const idx = ORDER.indexOf(current);
  return ORDER[(idx + 1) % ORDER.length] ?? 'system';
}

// Names the action plus the state (#243 Part B copy item 3) — the old
// "Theme: System" told a screen-reader user only what IS set, not what
// pressing the button does, and the announced name changed silently on the
// still-focused button right after activation with no separate cue that
// anything happened.
function labelFor(theme: Theme): string {
  return `Switch theme (current: ${theme})`;
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
