import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMediaQuery } from '../lib/use-media-query';

interface FakeMediaQueryList {
  matches: boolean;
  media: string;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  listeners: Array<(e: { matches: boolean }) => void>;
}

const fakes = new Map<string, FakeMediaQueryList>();

function makeMatchMedia(): (query: string) => FakeMediaQueryList {
  return (query) => {
    if (!fakes.has(query)) {
      const listeners: FakeMediaQueryList['listeners'] = [];
      fakes.set(query, {
        matches: false,
        media: query,
        listeners,
        addEventListener: vi.fn((_event, cb: (e: { matches: boolean }) => void) => {
          listeners.push(cb);
        }),
        removeEventListener: vi.fn((_event, cb: (e: { matches: boolean }) => void) => {
          const idx = listeners.indexOf(cb);
          if (idx >= 0) listeners.splice(idx, 1);
        }),
      });
    }
    return fakes.get(query)!;
  };
}

beforeEach(() => {
  fakes.clear();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: makeMatchMedia(),
  });
});

afterEach(() => {
  fakes.clear();
});

describe('useMediaQuery', () => {
  it('returns the initial match value from matchMedia', () => {
    const { result } = renderHook(() => useMediaQuery('(min-width: 640px)'));
    expect(result.current).toBe(false);
  });

  it('subscribes to change events and updates when the match flips', () => {
    const { result } = renderHook(() => useMediaQuery('(min-width: 640px)'));
    const mql = fakes.get('(min-width: 640px)')!;
    expect(mql.listeners).toHaveLength(1);

    act(() => {
      mql.matches = true;
      for (const cb of mql.listeners) cb({ matches: true });
    });
    expect(result.current).toBe(true);
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useMediaQuery('(min-width: 640px)'));
    const mql = fakes.get('(min-width: 640px)')!;
    expect(mql.removeEventListener).not.toHaveBeenCalled();
    unmount();
    expect(mql.removeEventListener).toHaveBeenCalledTimes(1);
  });

  it('returns false on the SSR snapshot when window is undefined', () => {
    const originalWindow = global.window;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined });
    const { result } = renderHook(() => useMediaQuery('(min-width: 999px)'));
    expect(result.current).toBe(false);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: originalWindow.matchMedia,
    });
  });
});
