import logoDark from '@/assets/logo-dark.svg';
import logoLight from '@/assets/logo-light.svg';
import { cn } from '@/lib/utils';

/**
 * The LCM hexagon-wave mark as a rounded app-icon tile. Ships one artwork per
 * theme (each tile's background matches that theme's `--background`) and swaps
 * them with the class-driven `dark:` variant so the mark follows the app theme,
 * not the OS preference. Decorative: callers pair it with a visible brand label.
 */
export function BrandMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <span aria-hidden className={cn('block shrink-0 select-none', className)}>
      <img src={logoLight} alt="" className="block h-full w-full dark:hidden" />
      <img src={logoDark} alt="" className="hidden h-full w-full dark:block" />
    </span>
  );
}
