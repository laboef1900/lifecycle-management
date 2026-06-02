import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, api } from '@/lib/api-client';

import { CategoriesForm } from './categories-form';

function renderWithClient(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('<CategoriesForm>', () => {
  beforeEach(() => {
    vi.spyOn(api.settings.categories, 'list').mockResolvedValue([
      { id: 'c1', name: 'Growth' },
      { id: 'c2', name: 'Hardware' },
    ]);
    vi.spyOn(api.settings.categories, 'create').mockResolvedValue({ id: 'c3', name: 'New' });
    vi.spyOn(api.settings.categories, 'delete').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the categories returned by the api', async () => {
    renderWithClient(<CategoriesForm />);
    expect(await screen.findByText('Growth')).toBeInTheDocument();
    expect(screen.getByText('Hardware')).toBeInTheDocument();
  });

  it('creates a category with the typed name when Add is clicked', async () => {
    renderWithClient(<CategoriesForm />);
    await screen.findByText('Growth');
    await userEvent.type(screen.getByLabelText(/new category/i), 'Migration');
    await userEvent.click(screen.getByRole('button', { name: /add/i }));
    await waitFor(() => {
      expect(api.settings.categories.create).toHaveBeenCalledWith('Migration');
    });
  });

  it('surfaces the CATEGORY_IN_USE message inline when delete is blocked', async () => {
    vi.mocked(api.settings.categories.delete).mockRejectedValue(
      new ApiError(409, {
        error: {
          code: 'CATEGORY_IN_USE',
          message: 'Category "Growth" is used by 2 item(s). Reassign them first.',
        },
      }),
    );
    renderWithClient(<CategoriesForm />);
    await screen.findByText('Growth');
    await userEvent.click(screen.getByRole('button', { name: /remove growth/i }));
    expect(await screen.findByText(/used by 2 item\(s\)/i)).toBeInTheDocument();
  });
});
