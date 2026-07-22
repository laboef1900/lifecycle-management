import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from './confirm-dialog';

type Props = React.ComponentProps<typeof ConfirmDialog>;

/**
 * Radix's DismissableLayer attaches its outside-pointerdown listener inside a
 * `setTimeout(0)`. Await one macrotask so the listener is live before we
 * dispatch, or the event is dropped and the outside-click assertion becomes a
 * no-op that passes with or without the gate.
 */
function flushRadixOutsideListener(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function setup(overrides: Partial<Props> = {}) {
  const onOpenChange = vi.fn();
  const onConfirm = vi.fn();
  render(
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="Delete host"
      description="This cannot be undone."
      confirmLabel="Delete"
      destructive
      pending={false}
      onConfirm={onConfirm}
      {...overrides}
    />,
  );
  return { onOpenChange, onConfirm };
}

describe('ConfirmDialog', () => {
  describe('when no mutation is pending', () => {
    it('closes on Escape', async () => {
      const { onOpenChange } = setup({ pending: false });
      await userEvent.keyboard('{Escape}');
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('closes on an outside pointer-down', async () => {
      const { onOpenChange } = setup({ pending: false });
      // Radix registers its outside-pointerdown listener on a setTimeout(0), so
      // let that macrotask run before dispatching — otherwise the event is missed
      // and the assertion would pass whether or not the guard exists.
      await flushRadixOutsideListener();
      // Dispatched directly: Radix sets `pointer-events: none` on the body while a
      // modal is open, so userEvent refuses the click; `pointerdown` on an outside
      // node is what DismissableLayer actually listens for.
      fireEvent.pointerDown(document.body);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('closes via the X control', async () => {
      const { onOpenChange } = setup({ pending: false });
      await userEvent.click(screen.getByRole('button', { name: /close/i }));
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('closes via Cancel', async () => {
      const { onOpenChange } = setup({ pending: false });
      await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('calls onConfirm from the confirm button', async () => {
      const { onConfirm } = setup({ pending: false });
      await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });
  });

  describe('while a mutation is in flight', () => {
    it('does not close on Escape', async () => {
      const { onOpenChange } = setup({ pending: true });
      await userEvent.keyboard('{Escape}');
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('does not close on an outside pointer-down', async () => {
      const { onOpenChange } = setup({ pending: true });
      await flushRadixOutsideListener();
      fireEvent.pointerDown(document.body);
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('does not close via the X control (it routes through the same guard)', async () => {
      const { onOpenChange } = setup({ pending: true });
      await userEvent.click(screen.getByRole('button', { name: /close/i }));
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('disables Cancel and the confirm button', () => {
      setup({ pending: true });
      expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /working/i })).toBeDisabled();
    });
  });
});
