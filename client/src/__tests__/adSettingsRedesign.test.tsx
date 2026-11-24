import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdSettingsPage from '@/app/dashboard/(main)/settings/ads/page';

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: mocks }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/components/settings/WorkspaceSettingsScope', () => ({ WorkspaceSettingsScope: () => <p>Workspace: test</p> }));
const settings = { defaultLifetimeBudget: 100, currency: 'USD', locations: [{ countryCode: 'US' }], autonomousOptimizationEnabled: false, liveProviderMutationsEnabled: false, analyticsSyncMinutes: 15 };
const autonomy = { mode: 'off', enabled: false, policyVersion: 'v1', consentedAt: null, notificationEmail: null, defaultThresholds: { minSpend: 25 } };
const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  vi.clearAllMocks(); mocks.get.mockImplementation(async path => ({ settings: path.endsWith('/autonomy') ? autonomy : settings, readiness: { meta: true, google: false, reasons: { google: 'Choose an account.' } }, environmentMutationGate: false }));
  mocks.put.mockImplementation(async (_path, body) => ({ settings: body }));
});
afterEach(() => {
  cleanup();
  if (originalScrollIntoView) Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView);
  else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});
describe('Ad Settings redesign', () => {
  it('labels the live-action permission and exposes all four modes with separate campaign consent', async () => {
    render(<AdSettingsPage />);
    await screen.findByLabelText('Amount');
    await userEvent.click(screen.getByRole('tab', { name: 'AI permissions' }));
    expect(screen.getByRole('switch', { name: 'Allow publishing and manual campaign actions' })).not.toBeChecked();
    const mode = screen.getByRole('combobox', { name: 'AI operating mode' });
    expect(mode).toHaveTextContent('Off');
    expect(screen.getByText('AI pauses also require the operating mode above, server availability, and consent on each campaign.')).toBeVisible();
    expect(screen.getByText('Switching the operating mode off cancels pending AI pauses.')).toBeVisible();
    fireEvent.keyDown(mode, { key: 'ArrowDown' });
    for (const label of ['Off', 'Evaluate privately', 'Recommendations only', 'Pause with campaign consent']) {
      expect(await screen.findByRole('option', { name: label })).toBeVisible();
    }
    expect(mocks.put).not.toHaveBeenCalled();
  });
  it('preserves edits across tabs and discards without any API mutation', async () => {
    render(<AdSettingsPage />); fireEvent.change(await screen.findByLabelText('Amount'), { target: { value: '125' } });
    await userEvent.click(screen.getByRole('tab', { name: 'AI permissions' })); fireEvent.change(screen.getByLabelText('Pause notification email'), { target: { value: 'alerts@example.test' } });
    await userEvent.click(screen.getByRole('tab', { name: 'Campaign defaults' })); expect(screen.getByLabelText('Amount')).toHaveValue(125); fireEvent.click(screen.getByRole('button', { name: 'Discard changes' })); expect(screen.getByLabelText('Amount')).toHaveValue(100); expect(mocks.put).not.toHaveBeenCalled();
  });
  it('saves only changed defaults and preserves provider permissions', async () => {
    render(<AdSettingsPage />); fireEvent.change(await screen.findByLabelText('Amount'), { target: { value: '125' } }); fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()); expect(mocks.put).toHaveBeenCalledExactlyOnceWith('/api/settings/ads', { ...settings, defaultLifetimeBudget: 125 });
  });
  it('keeps unsaved autonomy after a partial save and allows retry', async () => {
    mocks.put.mockImplementationOnce(async (_path, body) => ({ settings: body })).mockRejectedValueOnce(new Error('Autonomy unavailable'));
    render(<AdSettingsPage />); fireEvent.change(await screen.findByLabelText('Amount'), { target: { value: '125' } }); await userEvent.click(screen.getByRole('tab', { name: 'AI permissions' }));
    fireEvent.change(screen.getByLabelText('Pause notification email'), { target: { value: 'alerts@example.test' } }); fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Some changes could not be saved'); expect(screen.getByLabelText('Pause notification email')).toHaveValue('alerts@example.test');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' })); await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(3)); expect(mocks.put.mock.calls[2]).toEqual(['/api/settings/ads/autonomy', { mode: 'off', notificationEmail: 'alerts@example.test', defaultThresholds: { minSpend: 25 } }]);
  });
  it('withholds defaults and saving when a saved configuration read fails', async () => {
    mocks.get.mockRejectedValue(new Error('Offline')); render(<AdSettingsPage />); expect(await screen.findByRole('heading', { name: 'Ad Settings could not be loaded' })).toBeVisible(); expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull(); expect(mocks.put).not.toHaveBeenCalled();
  });
});
