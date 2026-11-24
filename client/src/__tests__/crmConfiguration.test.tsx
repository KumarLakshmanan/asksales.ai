import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CRMConfigurationPage from '@/app/dashboard/(main)/crm/configuration/page';
import { DEFAULT_CRM_CONFIGURATION, crmStagesForStatuses, type CrmConfiguration } from '@/lib/crm-configuration';

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), push: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: mocks }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/hooks/use-business-profiles', () => ({ useBusinessProfiles: () => ({ activeProfile: { id: 1, companyName: 'CRM test workspace', role: 'owner' }, isLoading: false, isError: false }), businessProfileName: (profile: { companyName: string }) => profile.companyName }));

const fixture = (): CrmConfiguration => ({
  stages: structuredClone(DEFAULT_CRM_CONFIGURATION.stages.filter(stage => ['new', 'contacted', 'won', 'lost'].includes(stage.key))),
  preferences: { ...DEFAULT_CRM_CONFIGURATION.preferences },
});

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  mocks.get.mockResolvedValue(fixture());
  mocks.put.mockResolvedValue(fixture());
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openWizard() {
  await act(async () => { render(<CRMConfigurationPage />); });
  await screen.findByRole('heading', { name: 'Configure Lead Stages' }, { timeout: 5000 });
  return userEvent.setup();
}

describe('CRM configuration workflow', () => {
  it('reviews and saves edited stages and preferences, preserving stage identifiers', async () => {
    const user = await openWizard();
    await user.clear(screen.getByLabelText('Stage name 2'));
    await user.type(screen.getByLabelText('Stage name 2'), ' In Progress ');
    fireEvent.change(screen.getByLabelText(/^Color for\s+In Progress\s*$/), { target: { value: '#ec4899' } });
    await user.click(screen.getByRole('switch', { name: 'Include Lost in flow' }));
    await user.click(screen.getByRole('button', { name: 'Move Won up' }));
    expect(screen.getByLabelText('Stage name 2')).toHaveValue('Won');
    await user.click(screen.getByRole('button', { name: 'Add Stage' }));
    await user.type(screen.getByLabelText('Stage name 5'), 'Qualified');
    await user.selectOptions(screen.getByLabelText('Type for Qualified'), 'won');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.selectOptions(screen.getByLabelText('Date Range'), '90d');
    await user.click(screen.getByRole('checkbox', { name: 'Email' }));
    await user.click(screen.getByRole('checkbox', { name: 'WhatsApp' }));
    expect(screen.getByRole('checkbox', { name: /All Platforms/ })).not.toBeChecked();
    await user.clear(screen.getByLabelText('Stuck Threshold'));
    await user.type(screen.getByLabelText('Stuck Threshold'), '14');
    await user.clear(screen.getByLabelText('Top Flows'));
    await user.type(screen.getByLabelText('Top Flows'), '8');
    await user.clear(screen.getByLabelText('Min Flow Count'));
    await user.type(screen.getByLabelText('Min Flow Count'), '4');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('heading', { name: 'Review Configuration' })).toBeVisible();
    expect(screen.getByText('Excluded from flow')).toBeVisible();
    expect(screen.getByText('Last 90 Days')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save configuration' }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/dashboard/crm/contacts'));
    const saved = mocks.put.mock.calls[0][1] as CrmConfiguration;
    expect(saved.stages.map(stage => stage.key).slice(0, 4)).toEqual(['new', 'won', 'contacted', 'lost']);
    expect(saved.stages[2]).toMatchObject({ label: 'In Progress', color: '#ec4899', type: 'active' });
    expect(saved.stages[3].inFlow).toBe(false);
    expect(saved.stages[4]).toMatchObject({ key: expect.stringMatching(/^stage_/), label: 'Qualified', type: 'won' });
    expect(saved.preferences).toEqual({ dateRange: '90d', platform: ['email', 'whatsapp'], stuckThreshold: 14, topFlows: 8, minFlowCount: 4 });
  }, 20000);

  it('loads the original single-platform setting and requires at least one checkbox selection', async () => {
    mocks.get.mockResolvedValueOnce({ ...fixture(), preferences: { ...fixture().preferences, platform: 'whatsapp' } });
    const user = await openWizard();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('checkbox', { name: 'WhatsApp' })).toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: 'WhatsApp' }));
    expect(screen.getByText('Keep at least one platform selected, or choose All Platforms.')).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'WhatsApp' })).toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: 'Email' }));
    await user.click(screen.getByRole('checkbox', { name: 'WhatsApp' }));
    await user.click(screen.getByRole('checkbox', { name: /All Platforms/ }));
    expect(screen.getByRole('checkbox', { name: 'Email' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'WhatsApp' })).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Save configuration' }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalled());
    expect(mocks.put.mock.calls[0][1].preferences.platform).toEqual(['all']);
  });

  it('rejects blank and duplicate stage names and invalid preference values before saving', async () => {
    const user = await openWizard();
    await user.click(screen.getByRole('button', { name: 'Add Stage' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Stage 5 needs a name of 1 to 80 characters.')).toBeVisible();
    await user.type(screen.getByLabelText('Stage name 5'), 'won');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('The stage name “won” is already used.')).toBeVisible();
    const added = screen.getByLabelText('Stage name 5').closest('[data-stage-key]')!;
    await user.click(within(added as HTMLElement).getByRole('button', { name: 'Remove won' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.change(screen.getByLabelText('Stuck Threshold'), { target: { value: '0' } });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Stuck threshold must be a whole number from 1 to 365 days.')).toBeVisible();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('keeps the draft after a rejected save and lets the same draft be retried', async () => {
    mocks.put.mockRejectedValueOnce(new Error('Ongoing is used by contacts.')).mockResolvedValueOnce(fixture());
    const user = await openWizard();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.change(screen.getByLabelText('Top Flows'), { target: { value: '9' } });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Save configuration' }));
    await screen.findByText('Ongoing is used by contacts.');
    expect(mocks.push).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Edit preferences' }));
    expect(screen.getByLabelText('Top Flows')).toHaveValue(9);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Save configuration' }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalled());
    expect(mocks.put.mock.calls[0][1]).toEqual(mocks.put.mock.calls[1][1]);
  });

  it('does not allow an unread configuration to be replaced with defaults', async () => {
    mocks.get.mockRejectedValueOnce(new Error('Configuration unavailable')).mockResolvedValueOnce(fixture());
    render(<CRMConfigurationPage />);
    await screen.findByRole('heading', { name: 'CRM configuration could not be loaded' });
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { name: 'Configure Lead Stages' });
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('cancels without persisting the draft', async () => {
    const user = await openWizard();
    await user.clear(screen.getByLabelText('Stage name 2'));
    await user.type(screen.getByLabelText('Stage name 2'), 'Unsaved');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.push).toHaveBeenCalledWith('/dashboard/crm/contacts');
  });

  it('validates and saves a custom range using inclusive UTC dates', async () => {
    const user = await openWizard();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.selectOptions(screen.getByLabelText('Date Range'), 'custom');
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-09-30' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-09-01' } });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('The end date must be on or after the start date.')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-09-30' } });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('2026-09-01 – 2026-09-30 (UTC)')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save configuration' }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalled());
    expect(mocks.put.mock.calls[0][1].preferences).toMatchObject({ dateRange: 'custom', dateStart: '2026-09-01', dateEnd: '2026-09-30' });
  });

  it('keeps an edited configuration when leaving is declined', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const user = await openWizard();
    fireEvent.change(screen.getByLabelText('Stage name 2'), { target: { value: 'Qualified' } });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mocks.push).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Stage name 2')).toHaveValue('Qualified');
  });

  it('offers recovery explicitly and preserves the business configuration revision', async () => {
    const saved = { ...fixture(), revision: 'a'.repeat(64) };
    mocks.get.mockResolvedValue(saved);
    const view = render(<CRMConfigurationPage />);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Configure Lead Stages' });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.change(screen.getByLabelText('Top Flows'), { target: { value: '9' } });
    view.unmount();
    render(<CRMConfigurationPage />);
    await screen.findByRole('button', { name: 'Restore unfinished draft' });
    await user.click(screen.getByRole('button', { name: 'Restore unfinished draft' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByLabelText('Top Flows')).toHaveValue(9);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Save configuration' }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalled());
    expect(mocks.put.mock.calls[0][1].revision).toBe(saved.revision);
    expect(sessionStorage.length).toBe(0);
  });

  it('keeps contacts in stages missing from a configuration discoverable', () => {
    const stages = crmStagesForStatuses(fixture().stages, ['demo', 'legacy_stage', 'demo']);
    expect(stages.filter(stage => stage.key === 'demo')).toHaveLength(1);
    expect(stages.find(stage => stage.key === 'legacy_stage')).toMatchObject({ label: 'legacy stage', inFlow: false });
  });
});
