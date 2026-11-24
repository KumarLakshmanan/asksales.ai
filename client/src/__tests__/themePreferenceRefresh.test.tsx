import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PreferencesProvider, usePreferences } from '@/contexts/PreferencesContext';

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), setTheme: vi.fn() }));
vi.mock('next-themes', () => ({ useTheme: () => ({ setTheme: mocks.setTheme }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true, isLoading: false }) }));
vi.mock('@/lib/api', () => ({ api: { get: mocks.get, put: mocks.put } }));
function Status() { const p = usePreferences(); return <p>{p.isLoading ? 'Loading' : p.preferences.theme}</p>; }
beforeEach(() => { vi.resetAllMocks(); mocks.get.mockResolvedValue({ theme: 'light', timezone: 'UTC' }); });
afterEach(cleanup);
it('does not refetch remote preferences when next-themes changes its setter after a local toggle', async () => {
  const view = render(<PreferencesProvider><Status /></PreferencesProvider>);
  await screen.findByText('light'); expect(mocks.get).toHaveBeenCalledOnce();
  mocks.setTheme = vi.fn();
  view.rerender(<PreferencesProvider><Status /></PreferencesProvider>);
  await waitFor(() => expect(screen.getByText('light')).toBeVisible());
  expect(mocks.get).toHaveBeenCalledOnce();
});
