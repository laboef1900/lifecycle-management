import { Toaster as SonnerToaster } from 'sonner';

import { useTheme } from '@/components/theme/use-theme';

export function Toaster(): React.JSX.Element {
  const { resolvedTheme } = useTheme();
  return (
    <SonnerToaster
      position="bottom-right"
      theme={resolvedTheme}
      richColors
      closeButton
      toastOptions={{
        classNames: {
          toast:
            'rounded-[var(--radius-card)] border-border shadow-[var(--overlay-shadow)] font-sans',
        },
      }}
    />
  );
}
