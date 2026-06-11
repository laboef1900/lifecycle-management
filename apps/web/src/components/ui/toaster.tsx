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
        // Inline styles: sonner's own [data-sonner-toast] rules load after our
        // utilities and win the cascade tie, so token classes are ignored.
        style: { borderRadius: 'var(--radius-card)', boxShadow: 'var(--overlay-shadow)' },
        classNames: {
          toast: 'border-border font-sans',
        },
      }}
    />
  );
}
