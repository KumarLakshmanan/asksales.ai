import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BrandToolkitPage from '@/app/dashboard/(main)/brand-toolkit/page';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/lib/api', () => ({ default: mocks }));

const brands = [
  { id: 1, name: 'Acorn & Co', isDefault: true },
  { id: 2, name: 'Northstar', isDefault: false },
];

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><BrandToolkitPage /></QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(brands);
});
afterEach(cleanup);

describe('Brand Toolkit card actions', () => {
  it('names each popup button for its brand and keeps its icon decorative', async () => {
    renderPage();
    for (const brand of brands) {
      const trigger = await screen.findByRole('button', { name: `Actions for ${brand.name}` });
      expect(trigger).toHaveAccessibleName(`Actions for ${brand.name}`);
      expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
      expect(trigger.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it.each(['{Enter}', ' '])('opens each named menu with %s and restores focus with Escape', async key => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: 'Add Brand' });
    await user.tab();
    expect(screen.getByRole('button', { name: 'Add Brand' })).toHaveFocus();
    for (const brand of brands) {
      const trigger = screen.getByRole('button', { name: `Actions for ${brand.name}` });
      // Reach both triggers through the actual tab order, including card footer actions.
      for (let step = 0; document.activeElement !== trigger && step < 5; step++) await user.tab();
      expect(trigger).toHaveFocus();
      await user.keyboard(key);
      expect(await screen.findByRole('menu')).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Edit Brand' })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
      await waitFor(() => expect(trigger).toHaveFocus());
    }
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it.each(['', '   '])('uses the existing untitled fallback for a blank brand name (%j)', async name => {
    mocks.get.mockResolvedValue([{ id: 1, name }]);
    renderPage();
    expect(await screen.findByRole('button', { name: 'Actions for Untitled Brand' })).toHaveAccessibleName('Actions for Untitled Brand');
  });
});
