import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { BrandMark } from './brand-mark';

describe('BrandMark', () => {
  it('ships one artwork per theme, swapped by the class-driven dark variant', () => {
    const { container } = render(<BrandMark />);
    const [light, dark, extra] = Array.from(container.querySelectorAll('img'));

    expect(light?.getAttribute('src')).toContain('logo-light');
    expect(light?.className).toContain('dark:hidden');
    expect(dark?.getAttribute('src')).toContain('logo-dark');
    expect(dark?.className).toContain('hidden');
    expect(dark?.className).toContain('dark:block');
    expect(extra).toBeUndefined();
  });

  it('is decorative: hidden from assistive tech with empty alt on both artworks', () => {
    const { container } = render(<BrandMark className="h-7 w-7" />);

    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    expect(container.firstElementChild?.className).toContain('h-7');
    for (const img of container.querySelectorAll('img')) {
      expect(img.getAttribute('alt')).toBe('');
    }
  });
});
