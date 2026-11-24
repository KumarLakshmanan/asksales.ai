vi.mock('@/hooks/use-outreach-draft-scope', () => ({ useOutreachDraftScope: () => mocks.scope }));
import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FollowUpsPage from '@/app/dashboard/(main)/outreach/follow-ups/page';
import { resetFollowUpSaveRecoveryForTests } from '@/lib/follow-up-save-recovery';
import { FollowUpTemplateDialog } from '@/components/follow-ups/FollowUpTemplates';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), toast: vi.fn(), replace: vi.fn(), query: '', scope: 'synthetic:4102' }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(mocks.query), useRouter: () => ({ replace: mocks.replace }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
vi.mock('@/lib/api', () => ({ default: mocks }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/contexts/PreferencesContext', () => ({ usePreferences: () => ({ formatDate: (value: string) => value }) }));
vi.mock('@/components/outreach/TemplateSelector', () => ({ TemplateSelector: () => null }));

function clickTab(name: string) { fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0, ctrlKey: false }); }
describe('dedicated follow-up management', () => {
  beforeEach(() => {
    vi.clearAllMocks(); resetFollowUpSaveRecoveryForTests(); vi.stubGlobal('crypto', webcrypto);
    mocks.query = ''; mocks.scope = 'synthetic:4102';
    mocks.get.mockImplementation(async (url: string) => url.includes('integrations/') ? { enableAutoFollowUp: false, followUpSteps: [{ id: 1, delayValue: 1, delayUnit: 'days', delayHours: 24, templateId: null, templateName: '' }] } : url.includes('/templates?') ? { templates: [], total: 0 } : []);
  });
  it('opens finder query destinations while already on the follow-up page', async () => {
    const client = new QueryClient();
    const page = () => <QueryClientProvider client={client}><FollowUpsPage /></QueryClientProvider>;
    const view = render(page());
    await screen.findByRole('button', { name: 'Save Settings' });
    mocks.query = 'tab=history'; view.rerender(page());
    await waitFor(() => expect(screen.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true'));
    expect(await screen.findByRole('heading', { name: 'Follow-up history' })).toBeVisible();
    mocks.query = 'tab=templates'; view.rerender(page());
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Templates' })).toHaveAttribute('aria-selected', 'true'));
    expect(await screen.findByRole('button', { name: 'Create template' })).toBeVisible();
    mocks.query = ''; mocks.scope = 'synthetic:4102'; view.rerender(page());
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true'));
    expect(await screen.findByRole('button', { name: 'Save Settings' })).toBeVisible();
    mocks.query = 'tab=unsupported&channel=linkedin'; view.rerender(page());
    expect(screen.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: 'LinkedIn' })).toBeNull();
  });
  it('shows five channels with separate settings, history and templates', async () => {
    render(<QueryClientProvider client={new QueryClient()}><FollowUpsPage /></QueryClientProvider>);
    expect(screen.queryByRole('main')).toBeNull();
    for (const channel of ['Email', 'WhatsApp', 'Instagram', 'Facebook', 'SMS']) expect(screen.getByRole('tab', { name: channel })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /LinkedIn|Twitter/ })).not.toBeInTheDocument();
    await screen.findByRole('button', { name: 'Save Settings' });
    clickTab('WhatsApp');
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/settings/integrations/whatsapp/follow-ups', expect.objectContaining({ signal: expect.anything() })));
    clickTab('History');
    expect(await screen.findByText('No follow-ups yet')).toBeInTheDocument();
    expect(mocks.replace).toHaveBeenCalledWith('/dashboard/outreach/follow-ups?tab=history&channel=whatsapp', { scroll: false });
    expect(mocks.get).toHaveBeenCalledWith('/api/sent-messages?followUps=true&channel=whatsapp&limit=25&offset=0', expect.objectContaining({ signal: expect.anything() }));
    clickTab('Templates');
    expect(await screen.findByRole('button', { name: 'Create template' })).toBeInTheDocument();
  });
  it('keeps channel deep links and selected views in sync while the page stays mounted', async () => {
    const client = new QueryClient();
    const page = () => <QueryClientProvider client={client}><FollowUpsPage /></QueryClientProvider>;
    const view = render(page());
    await screen.findByRole('button', { name: 'Save Settings' });
    mocks.query = 'channel=sms'; view.rerender(page());
    await waitFor(() => expect(screen.getByRole('tab', { name: 'SMS' })).toHaveAttribute('aria-selected', 'true'));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/settings/integrations/sms/follow-ups', expect.objectContaining({ signal: expect.anything() })));
    clickTab('Instagram');
    expect(mocks.replace).toHaveBeenCalledWith('/dashboard/outreach/follow-ups?channel=instagram&tab=settings', { scroll: false });
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/settings/integrations/instagram/follow-ups', expect.objectContaining({ signal: expect.anything() })));
  });
  it.each(['email', 'whatsapp', 'instagram', 'facebook', 'sms'])('shows the timing basis and saves the displayed 1-hour and 1-day sequence for %s', async channel => {
    mocks.query = `channel=${channel}`;
    mocks.get.mockResolvedValue({ enableAutoFollowUp: true, followUpSteps: [
      { id: 1, delayValue: 1, delayUnit: 'hours', delayHours: 1, templateId: -1 },
      { id: 2, delayValue: 1, delayUnit: 'days', delayHours: 24, templateId: -1 },
    ] });
    mocks.put.mockResolvedValue({ success: true });
    render(<QueryClientProvider client={new QueryClient()}><FollowUpsPage /></QueryClientProvider>);
    await screen.findByRole('button', { name: 'Save Settings' });
    expect(screen.getByText(/1 hour and 24 hours after that message/)).toBeVisible();
    expect(screen.getAllByText('after initial message')).toHaveLength(2);
    expect(screen.getByLabelText('Step 1 delay unit')).toHaveTextContent('Hours');
    expect(screen.getByLabelText('Step 2 delay unit')).toHaveTextContent('Days');
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith(`/api/settings/integrations/${channel}/follow-ups`, expect.objectContaining({
      enableAutoFollowUp: true, followUpSteps: [
        expect.objectContaining({ delayValue: 1, delayUnit: 'hours', delayHours: 1 }),
        expect.objectContaining({ delayValue: 1, delayUnit: 'days', delayHours: 24 }),
      ],
    }), expect.objectContaining({ signal: expect.anything() })));
  });
  it('blocks invalid delay order, enforces the ten-step limit and retains failed saves', async () => {
    mocks.put.mockRejectedValueOnce(new Error('Saved sequence unavailable'));
    render(<QueryClientProvider client={new QueryClient()}><FollowUpsPage /></QueryClientProvider>);
    await screen.findByRole('button', { name: 'Save Settings' });
    fireEvent.click(screen.getByRole('button', { name: 'Add Follow-Up Step' }));
    fireEvent.change(screen.getByLabelText('Step 2 delay'), { target: { value: '1' } });
    expect(screen.getByRole('alert')).toHaveTextContent('choose a delay later than step 1');
    expect(screen.getByRole('button', { name: 'Save Settings' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Step 2 delay'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ description: 'Saved sequence unavailable' })));
    expect(screen.getByLabelText('Step 2 delay')).toHaveValue(2);
    for (let i = 0; i < 8; i++) fireEvent.click(screen.getByRole('button', { name: 'Add Follow-Up Step' }));
    expect(screen.getByRole('button', { name: '10-step limit reached' })).toBeDisabled();
  });
  it.each(['email', 'whatsapp', 'instagram', 'facebook', 'sms'] as const)('creates a reusable %s template without resolving recipient variables', async channel => {
    const onCreated = vi.fn(); const close = vi.fn();
    mocks.post.mockResolvedValueOnce({ id: 77, name: 'Support check-in', content: 'Hi {{first_name}}, still need help?' });
    render(<FollowUpTemplateDialog channel={channel} open onOpenChange={close} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'Support check-in' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hi {{first_name}}, still need help?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 77 })));
    expect(mocks.post).toHaveBeenCalledWith('/api/content/templates', expect.objectContaining({ type: ['instagram', 'facebook'].includes(channel) ? 'social_message' : channel, content: 'Hi {{first_name}}, still need help?' }), expect.objectContaining({ signal: expect.anything(), headers: { 'Idempotency-Key': expect.any(String) } }));
    expect(close).toHaveBeenCalledWith(false);
  });
  it('shares fictional preview and rejects unsupported tokens before creation',()=>{
    render(<FollowUpTemplateDialog channel="whatsapp" open onOpenChange={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Template name'),{target:{value:'QA draft'}});
    fireEvent.change(screen.getByLabelText('Message'),{target:{value:'Hello {{first_name}}, {{unknown_token}}'}});
    expect(screen.getByRole('button',{name:'Create template'})).toBeDisabled();
    fireEvent.click(screen.getByText('Preview QA draft · whatsapp'));
    fireEvent.change(screen.getByLabelText('Sample first_name'),{target:{value:'Fictional guest'}});
    expect(screen.getByText('Hello Fictional guest, {{unknown_token}}')).toBeVisible();
    expect(screen.getByText(/Business status: Draft/)).toBeVisible();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('keeps timing edits while creating a reusable template and suppresses repeated settings saves', async () => {
    const revision = 'a'.repeat(64);
    mocks.get.mockResolvedValue({ revision, enableAutoFollowUp: false, followUpSteps: [{ id: 1, delayValue: 5, delayUnit: 'minutes', delayHours: 5 / 60, templateId: null, templateName: '' }] });
    let finish!: (value: unknown) => void;
    mocks.put.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    mocks.post.mockResolvedValue({ id: 77, name: 'Synthetic check-in', content: 'Hi {{first_name}}' });
    render(<QueryClientProvider client={new QueryClient()}><FollowUpsPage /></QueryClientProvider>);
    await screen.findByRole('button', { name: 'Save Settings' });
    fireEvent.change(screen.getByLabelText('Step 1 delay'), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create template for step 1' }));
    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'Synthetic check-in' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hi {{first_name}}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByLabelText('Step 1 delay')).toHaveValue(15);
    expect(screen.getByRole('button', { name: 'Choose template for step 1' })).toHaveTextContent('Synthetic check-in');
    const save = screen.getByRole('button', { name: 'Save Settings' });
    fireEvent.click(save); fireEvent.click(save);
    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(mocks.put).toHaveBeenCalledWith('/api/settings/integrations/email/follow-ups', expect.objectContaining({ expectedRevision: revision, enableAutoFollowUp: false, followUpSteps: [expect.objectContaining({ delayValue: 15, delayUnit: 'minutes', delayHours: 0.25, templateId: 77 })] }), expect.objectContaining({ signal: expect.anything() }));
    finish({ success: true, revision: 'b'.repeat(64) });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    expect(mocks.put.mock.calls[1][1].expectedRevision).toBe('b'.repeat(64));
    finish({ success: true, revision: 'b'.repeat(64) });
  });
  it('retains a conflicted settings draft and reloads only after explicit discard', async () => {
    mocks.put.mockRejectedValue(new Error('These follow-up settings changed elsewhere.'));
    render(<QueryClientProvider client={new QueryClient()}><FollowUpsPage /></QueryClientProvider>);
    await screen.findByRole('button', { name: 'Save Settings' });
    fireEvent.change(screen.getByLabelText('Step 1 delay'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('changed elsewhere');
    expect(screen.getByLabelText('Step 1 delay')).toHaveValue(2);
    fireEvent.click(screen.getByRole('button', { name: 'Discard edits and reload' }));
    await waitFor(() => expect(screen.getByLabelText('Step 1 delay')).toHaveValue(1));
  });
  it('does not truncate decimal timing inputs into a valid value', async () => {
    render(<QueryClientProvider client={new QueryClient()}><FollowUpsPage /></QueryClientProvider>);
    await screen.findByRole('button', { name: 'Save Settings' });
    fireEvent.change(screen.getByLabelText('Step 1 delay'), { target: { value: '1.5' } });
    expect(screen.getByRole('alert')).toHaveTextContent('whole-number delay');
    expect(screen.getByRole('button', { name: 'Save Settings' })).toBeDisabled();
    expect(mocks.put).not.toHaveBeenCalled();
  });
  it('clears cancelled template drafts and ignores a create response after scope changes', async () => {
    let finish!: (value: unknown) => void;
    mocks.post.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const created = vi.fn(); const close = vi.fn();
    const view = render(<FollowUpTemplateDialog channel="email" open onOpenChange={close} onCreated={created} />);
    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'Private draft' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Synthetic private wording' } });
    view.rerender(<FollowUpTemplateDialog channel="email" open={false} onOpenChange={close} onCreated={created} />);
    view.rerender(<FollowUpTemplateDialog channel="email" open onOpenChange={close} onCreated={created} />);
    expect(screen.getByLabelText('Message')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'Private draft' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Synthetic private wording' } });
    const form = screen.getByLabelText('Message').closest('form')!;
    fireEvent.submit(form); fireEvent.submit(form);
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('Message')).toBeDisabled();
    mocks.scope = 'another-user:another-business';
    view.rerender(<FollowUpTemplateDialog channel="email" open onOpenChange={close} onCreated={created} />);
    expect(screen.getByLabelText('Message')).toHaveValue('');
    finish({ id: 77, name: 'Private draft', content: 'Synthetic private wording' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create template' })).toBeDisabled());
    expect(created).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
  it('retains template fields after server rejection and rejects malformed success responses', async () => {
    mocks.post.mockRejectedValueOnce(Object.assign(new Error('Approve the selected business profile before generating content.'), { status: 403 })).mockResolvedValueOnce({});
    render(<FollowUpTemplateDialog channel="email" open onOpenChange={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'Synthetic template' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hi {{first_name}}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create template' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Approve');
    expect(screen.getByLabelText('Message')).toHaveValue('Hi {{first_name}}');
    fireEvent.click(screen.getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('could not be saved'));
    expect(screen.getByLabelText('Template name')).toHaveValue('Synthetic template');
  });
  it('ignores settings save completion after moving to another business', async () => {
    let finish!: (value: unknown) => void;
    mocks.put.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const page = () => <QueryClientProvider client={new QueryClient()}><FollowUpsPage /></QueryClientProvider>;
    const view = render(page());
    await screen.findByRole('button', { name: 'Save Settings' });
    fireEvent.change(screen.getByLabelText('Step 1 delay'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
    mocks.scope = 'synthetic:another-business'; view.rerender(page());
    await waitFor(() => expect(screen.getByLabelText('Step 1 delay')).toHaveValue(1));
    finish({ success: true, revision: 'b'.repeat(64) });
    await Promise.resolve();
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Settings Saved' }));
  });

  it('shows a settings skeleton and holds the other channel tabs until the saved settings load', async () => {
    let finish!: (value: unknown) => void;
    mocks.get.mockImplementation((url: string) => url.includes('integrations/')
      ? new Promise(resolve => { finish = resolve; })
      : Promise.resolve(url.includes('/templates?') ? { templates: [], total: 0 } : []));
    render(<QueryClientProvider client={new QueryClient()}><FollowUpsPage /></QueryClientProvider>);
    expect(await screen.findByText('Loading follow-up settings…')).toBeInTheDocument();
    expect(screen.getByTestId('follow-up-settings-skeleton')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'WhatsApp' })).toBeDisabled();
    expect(screen.getByRole('tab', { name: 'Email' })).not.toBeDisabled();
    finish({ enableAutoFollowUp: false, followUpSteps: [{ id: 1, delayValue: 1, delayUnit: 'days', delayHours: 24, templateId: null, templateName: '' }] });
    await screen.findByRole('button', { name: 'Save Settings' });
    expect(screen.queryByTestId('follow-up-settings-skeleton')).toBeNull();
    expect(screen.getByRole('tab', { name: 'WhatsApp' })).not.toBeDisabled();
  });

});
