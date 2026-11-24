import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PageErrorState } from '@/components/ui/page-state';
import DashboardError from '@/app/dashboard/error';
import { isPageChunkError, reloadCurrentPage } from '@/lib/page-error-recovery';
vi.mock('@/lib/page-error-recovery', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/page-error-recovery')>(), reloadCurrentPage: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('page error recovery', () => {
  it('reloads a failed dashboard chunk instead of resetting its rejected import', () => {
    const reset = vi.fn();
    render(<DashboardError error={Object.assign(new Error('Loading chunk 35105 failed.'), { name: 'ChunkLoadError' })} reset={reset} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reload page' }));
    expect(reloadCurrentPage).toHaveBeenCalledOnce();
    expect(reset).not.toHaveBeenCalled();
  });
  it('retains ordinary retry and offers a full reload as a fallback', () => {
    const reset = vi.fn();
    render(<PageErrorState error={new Error('Network unavailable')} reset={reset} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Reload page' }));
    expect(reloadCurrentPage).toHaveBeenCalledOnce();
  });
  it.each(['Failed to fetch dynamically imported module: /page.js', 'Importing a module script failed.', 'Loading CSS chunk app failed.'])('recognizes alternate chunk failure: %s', message => {
    expect(isPageChunkError(new Error(message))).toBe(true);
  });
});
