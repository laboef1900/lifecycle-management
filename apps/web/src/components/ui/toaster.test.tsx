import { render, screen } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it } from 'vitest';

import { ThemeContext } from '@/components/theme/use-theme';

import { Toaster } from './toaster';

function renderToaster() {
  return render(
    <ThemeContext.Provider
      value={{ theme: 'dark', resolvedTheme: 'dark', setTheme: () => undefined }}
    >
      <Toaster />
    </ThemeContext.Provider>,
  );
}

describe('<Toaster>', () => {
  afterEach(() => {
    toast.dismiss();
  });

  it('applies radius and shadow tokens inline so sonner CSS cannot override them', async () => {
    renderToaster();
    toast('token check');
    const item = (await screen.findByText('token check')).closest('[data-sonner-toast]')!;
    const style = (item as HTMLElement).style;
    expect(style.borderRadius).toBe('var(--radius-card)');
    expect(style.boxShadow).toBe('var(--overlay-shadow)');
  });

  it('follows the resolved theme', async () => {
    const { container } = renderToaster();
    toast('theme check');
    await screen.findByText('theme check');
    expect(container.querySelector('[data-sonner-toaster]')).toHaveAttribute(
      'data-sonner-theme',
      'dark',
    );
  });
});
