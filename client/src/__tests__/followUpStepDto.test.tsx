import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FollowUpSettings } from '@/components/FollowUpSettings';
import { SavedFollowUpSummary } from '@/components/outreach/create/SavedFollowUpSummary';
import { followUpSettingsFingerprint, type ChannelFollowUpSettings } from '@/hooks/use-channel-follow-up-settings';
import { getFollowUpSaveRecovery, resetFollowUpSaveRecoveryForTests, startFollowUpSave } from '@/lib/follow-up-save-recovery';

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: mocks }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/hooks/use-outreach-draft-scope', () => ({ useOutreachDraftScope: () => '4101:4102' }));
vi.mock('@/components/outreach/TemplateSelector', () => ({ TemplateSelector: () => null }));
const settings: ChannelFollowUpSettings = {
  revision: 'initial', fenced: true, enableAutoFollowUp: true,
  followUpSteps: [
    { id: 'paused-alpha', enabled: false, delayValue: 3, delayUnit: 'days', templateId: 77, templateName: 'Private disabled wording' },
    { id: '007', enabled: true, delayValue: 1, delayUnit: 'hours', templateId: -1, templateName: 'Auto-generate' },
    { id: 'paused-zero', enabled: false, delayValue: 0, delayUnit: 'minutes', templateId: null, templateName: '' },
    { id: '02', enabled: true, delayValue: 1, delayUnit: 'days', templateId: -1, templateName: 'Auto-generate' },
  ],
};
beforeEach(() => { vi.clearAllMocks(); resetFollowUpSaveRecoveryForTests(); mocks.get.mockResolvedValue(settings); mocks.put.mockResolvedValue({ success: true, fenced: true, advanced: true, revision: 'advanced' }); });
afterEach(() => { cleanup(); resetFollowUpSaveRecoveryForTests(); });
describe('lossless follow-up step client contract', () => {
  it('saves unchanged opaque IDs and flags without enforcing ordering on disabled steps', async () => {
    render(<FollowUpSettings integrationKey="email" />);
    const save = await screen.findByRole('button', { name: 'Save Settings' });
    expect(save).toBeEnabled(); expect(screen.getByLabelText('Enable step 1')).not.toBeChecked();
    expect(screen.getByLabelText('Enable step 2')).toBeChecked(); expect(screen.getByLabelText('Step 3 delay')).toHaveValue(0);
    fireEvent.click(save);
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith('/api/settings/integrations/email/follow-ups', expect.objectContaining({
      expectedRevision: 'initial', followUpSteps: settings.followUpSteps.map(step => expect.objectContaining({ id: step.id, enabled: step.enabled })),
    }), expect.objectContaining({ signal: expect.anything() })));
  });
  it('validates newly enabled ordering and keeps disabled rows editable without silently enabling them', async () => {
    render(<FollowUpSettings integrationKey="email" />); const save = await screen.findByRole('button', { name: 'Save Settings' });
    fireEvent.click(screen.getByLabelText('Enable step 1')); expect(save).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Step 2: choose a delay later than step 1');
    fireEvent.click(screen.getByLabelText('Enable step 1')); expect(save).toBeEnabled();
  });
  it('retains opaque IDs and disabled flags across uncertain-save pageshow recovery without private wording', () => {
    const settle = startFollowUpSave('4101:4102', 'email', settings, settings); if (!settle) throw new Error('Save did not start'); settle('uncertain');
    act(() => window.dispatchEvent(new Event('pageshow')));
    const recovered = getFollowUpSaveRecovery('4101:4102').email?.unconfirmed;
    expect(recovered?.followUpSteps.map(({ id, enabled }) => ({ id, enabled }))).toEqual(settings.followUpSteps.map(({ id, enabled }) => ({ id, enabled })));
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('Private disabled wording');
    expect(followUpSettingsFingerprint(settings)).not.toBe(followUpSettingsFingerprint({ ...settings, followUpSteps: settings.followUpSteps.map(step => ({ ...step, enabled: true })) }));
  });
  it('summarizes only steps that can actually send', () => {
    render(<SavedFollowUpSummary channel="email" label="Email" settings={settings} loading={false} error="" onRetry={vi.fn()} />);
    expect(screen.queryByText('Private disabled wording')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});
