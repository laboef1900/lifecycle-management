import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  destructive?: boolean;
  /**
   * When set, the confirm button stays disabled until the user types this exact
   * phrase (trimmed, case-sensitive). A typed-name gate for high-blast-radius,
   * irreversible actions (permanent cluster delete): friction proportional to
   * consequence, so a single misclick can't destroy the source of truth.
   */
  confirmPhrase?: string;
  /**
   * A persistent, in-dialog error shown when the confirmed mutation fails. The
   * dialog stays open on error, so this — not a transient toast a screen reader
   * has already moved past — is the durable signal; the user retries with the
   * same confirm button.
   */
  error?: string | null;
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
  confirmPhrase,
  error,
  pending,
  onConfirm,
}: ConfirmDialogProps): React.JSX.Element {
  const [typed, setTyped] = React.useState('');
  // Reset the typed gate whenever the dialog transitions closed, so a reopen
  // never starts pre-satisfied from a previous attempt. React's "adjust state
  // during render on a prop change" pattern — deliberately not an effect.
  const [prevOpen, setPrevOpen] = React.useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (!open) setTyped('');
  }
  const phraseSatisfied = confirmPhrase === undefined || typed.trim() === confirmPhrase;
  const inputId = React.useId();
  const errorId = React.useId();

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
        {confirmPhrase !== undefined ? (
          <div className="space-y-1.5">
            <label htmlFor={inputId} className="block text-sm text-fg-muted">
              Type <span className="font-mono font-medium text-foreground">{confirmPhrase}</span> to
              confirm.
            </label>
            <Input
              id={inputId}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={pending}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label={`Type ${confirmPhrase} to confirm`}
            />
          </div>
        ) : null}
        {error ? (
          <p
            id={errorId}
            role="alert"
            className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'accent'}
            onClick={onConfirm}
            disabled={pending || !phraseSatisfied}
            aria-describedby={error ? errorId : undefined}
          >
            {pending ? 'Working…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
