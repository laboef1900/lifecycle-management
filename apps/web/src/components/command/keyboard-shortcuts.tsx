import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

const SEQUENCE_TIMEOUT_MS = 1000;

export function KeyboardShortcuts(): React.JSX.Element {
  const navigate = useNavigate();
  const pendingPrefix = useRef<string | null>(null);
  const pendingTimer = useRef<number | null>(null);

  useEffect(() => {
    const clearPrefix = (): void => {
      pendingPrefix.current = null;
      if (pendingTimer.current !== null) {
        window.clearTimeout(pendingTimer.current);
        pendingTimer.current = null;
      }
    };

    const handler = (event: KeyboardEvent): void => {
      if (isTypingTarget(event.target)) return;

      // Cmd+K / Ctrl+K — open palette
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('lcm:open-command-palette'));
        clearPrefix();
        return;
      }

      // No modifiers from here on
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === '?') {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('lcm:open-shortcuts'));
        clearPrefix();
        return;
      }

      // Vim-style two-key sequences
      if (pendingPrefix.current === 'g') {
        if (event.key === 'o') {
          event.preventDefault();
          navigate({ to: '/' });
        } else if (event.key === 'c') {
          event.preventDefault();
          navigate({ to: '/clusters' });
        } else if (event.key === 's') {
          event.preventDefault();
          navigate({ to: '/settings' });
        }
        clearPrefix();
        return;
      }

      if (event.key === 'g') {
        pendingPrefix.current = 'g';
        pendingTimer.current = window.setTimeout(clearPrefix, SEQUENCE_TIMEOUT_MS);
      }
    };

    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
      clearPrefix();
    };
  }, [navigate]);

  return <></>;
}
