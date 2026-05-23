import { Menu } from 'lucide-react';
import { createContext, useContext, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';

interface MobileNavContextValue {
  open: boolean;
  setOpen: (next: boolean) => void;
}

const MobileNavContext = createContext<MobileNavContextValue | null>(null);

export function MobileNavProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const value = useMemo(() => ({ open, setOpen }), [open]);
  return <MobileNavContext.Provider value={value}>{children}</MobileNavContext.Provider>;
}

export function useMobileNav(): MobileNavContextValue {
  const value = useContext(MobileNavContext);
  if (!value) {
    throw new Error('useMobileNav must be used inside <MobileNavProvider>');
  }
  return value;
}

export function MobileNavTrigger(): React.JSX.Element {
  const { setOpen } = useMobileNav();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label="Open navigation"
      className="lg:hidden"
      onClick={() => setOpen(true)}
    >
      <Menu className="h-5 w-5" />
    </Button>
  );
}
