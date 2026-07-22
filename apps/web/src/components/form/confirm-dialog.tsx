import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  destructive?: boolean;
  /**
   * Whether the confirmed mutation is in flight. Required (not advisory): while
   * true, every close path is sealed, so an omitted `pending` would silently
   * reopen the dismiss-mid-submit hole this component exists to close (#262).
   */
  pending: boolean;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  destructive = false,
  pending,
  onConfirm,
}: ConfirmDialogProps): React.JSX.Element {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // React Query does not cancel a mutation on unmount: a dialog dismissed
        // mid-submit still runs its onSuccess, which typically clears the parent's
        // target and can force-close a *different* dialog the user has since
        // opened, discarding their input. While the mutation is pending, seal
        // every close path. ESC, outside-click, and the shared DialogContent X
        // all route through onOpenChange, so this one guard covers the X too;
        // the preventDefaults below stop Radix dismissing before it asks. See #262.
        if (pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        onEscapeKeyDown={(e) => {
          if (pending) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (pending) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'accent'}
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? 'Working…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
