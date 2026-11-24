import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BasicConfiguration, ModelConfiguration } from '@/components/outreach/assistants/AssistantConfiguration';
import { AvailabilityConfiguration } from '@/components/outreach/assistants/AssistantAvailability';
import { FollowUpDelay, FollowUpsConfiguration } from '@/components/outreach/assistants/AssistantFollowUpConfiguration';
import { emptyAssistantDraft, type AssistantDraft } from '@/lib/outreach-assistants';
import { setupCatalog } from './fixtures/assistantSetupCatalog';
import api from '@/lib/api';

const mocks = vi.hoisted(() => ({ workspace: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: { get: vi.fn() } }));
vi.mock('@/hooks/use-outreach-assistants', () => ({ ASSISTANT_API: '/api/settings/outreach/assistants', useAssistantWorkspace: mocks.workspace }));
function draft(): AssistantDraft { return { ...emptyAssistantDraft(), name: 'Front desk', agentType: 'hotel_sales', replyModel: { provider: 'openai', model: 'fixture-gpt' }, bindings: [{ channel: 'whatsapp', surface: 'private', accountId: 'same-id' }] }; }
beforeEach(() => {
  vi.resetAllMocks();
  mocks.workspace.mockReturnValue({ profileId: 1, scopeKey: ['outreach-assistants', 7, 1], requestOptions: { headers: { 'X-Business-Profile-Id': '1' } }, catalog: { data: setupCatalog } });
  vi.mocked(api.get).mockResolvedValue(setupCatalog);
});
afterEach(cleanup);
function Harness({ section, initial = draft() }: { section: 'models' | 'followups' | 'availability'; initial?: AssistantDraft }) {
  const [value, setValue] = useState(initial);
  return <><output data-testid="draft">{JSON.stringify(value)}</output>{section === 'models' ? <ModelConfiguration draft={value} catalog={setupCatalog} onChange={setValue} /> : section === 'followups' ? <FollowUpsConfiguration draft={value} catalog={setupCatalog} onChange={setValue} history={<p>Loaded delivery history</p>} /> : <AvailabilityConfiguration draft={value} catalog={setupCatalog} onChange={setValue} />}</>;
}
const read = () => JSON.parse(screen.getByTestId('draft').textContent!) as AssistantDraft;
const mount = (section: 'models' | 'followups' | 'availability', initial?: AssistantDraft) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Harness section={section} initial={initial} /></QueryClientProvider>);

describe('assistant step designs and behavior', () => {
  it('shows selectable account cards without five repetitive empty channel groups', () => {
    render(<BasicConfiguration draft={draft()} catalog={setupCatalog} assistantId="draft-one" onChange={vi.fn()} />);
    expect(screen.getByRole('checkbox', { name: 'Orchid business line · Private messages' })).toBeChecked();
    expect(screen.queryByText('No account is connected.')).not.toBeInTheDocument();
    expect(screen.queryByText('Offline line')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Instagram comments · Public comments' })).toBeInTheDocument();
  });
  it('adds a backup from the AJAX catalog without changing the primary reply model', async () => {
    mount('models');
    fireEvent.click(screen.getByRole('button', { name: 'Choose backup models' }));
    const drawer = await screen.findByRole('dialog', { name: 'Choose backup models' });
    expect(within(drawer).queryByRole('checkbox', { name: /GPT Luna/ })).not.toBeInTheDocument();
    fireEvent.click(await within(drawer).findByRole('checkbox', { name: /Gemini 3.5 Plus/ }));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply models' }));
    expect(read().replyModel).toEqual({ provider: 'openai', model: 'fixture-gpt' });
    expect(read().fallbackModels).toEqual([{ provider: 'openrouter', model: 'fixture/gemini' }]);
    expect(api.get).toHaveBeenCalledWith('/api/settings/outreach/assistants/catalog', expect.objectContaining({ headers: { 'X-Business-Profile-Id': '1' }, signal: expect.any(AbortSignal) }));
  });
  it('changing the primary model removes its duplicate fallback and unsupported response controls', async () => {
    const initial = draft(); initial.response.temperature = 0.5; initial.fallbackModels = [{ provider: 'openrouter', model: 'fixture/gemini' }];
    mount('models', initial);
    fireEvent.click(screen.getByRole('button', { name: 'Change reply model' }));
    const drawer = await screen.findByRole('dialog', { name: 'Choose reply model' });
    fireEvent.click(await within(drawer).findByRole('radio', { name: /Gemini 3.5 Plus/ }));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply models' }));
    expect(read().replyModel).toEqual({ provider: 'openrouter', model: 'fixture/gemini' });
    expect(read().fallbackModels).toEqual([]); expect(read().response.temperature).toBeUndefined();
  });
  it('builds a channel check-in sequence and makes disabling it explicit', () => {
    mount('followups');
    expect(read().followUps.mode).toBe('unconfigured');
    fireEvent.click(screen.getByRole('radio', { name: /Schedule check-ins/ }));
    fireEvent.click(screen.getByRole('button', { name: 'WhatsApp' }));
    expect(read().followUps.sequences).toEqual([{ channel: 'whatsapp', steps: [{ delayMinutes: 60, templateId: 0 }] }]);
    fireEvent.change(screen.getByLabelText('Message 1 wait'), { target: { value: '2' } });
    expect(read().followUps.sequences[0].steps[0].delayMinutes).toBe(120);
    fireEvent.click(screen.getByRole('radio', { name: /No automatic follow-ups/ }));
    expect(read().followUps).toEqual({ mode: 'none', sequences: [] });
    expect(read().replyModel).toEqual(draft().replyModel);
    expect(screen.queryByText('Loaded delivery history')).not.toBeInTheDocument();
  });
  it('changing the displayed wait unit preserves the stored delay', () => {
    const change = vi.fn();
    render(<FollowUpDelay index={0} minutes={90} onChange={change} />);
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'hours' } });
    expect(screen.getByLabelText('Message 1 wait')).toHaveValue(1.5);
    expect(change).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Message 1 wait'), { target: { value: '2' } });
    expect(change).toHaveBeenCalledWith(120);
  });
  it('offers AI check-ins below 24 hours and preserves an invalid choice for repair when the delay is extended', () => {
    mount('followups');
    fireEvent.click(screen.getByRole('radio', { name: /Schedule check-ins/ }));
    fireEvent.click(screen.getByRole('button', { name: 'WhatsApp' }));
    fireEvent.change(screen.getByLabelText('Message 1 content'), { target: { value: 'ai' } });
    expect(read().followUps.sequences[0].steps[0]).toEqual({ delayMinutes: 60, templateId: 0, messageMode: 'ai' });
    expect(screen.queryByRole('button', { name: 'Message 1 template' })).not.toBeInTheDocument();
    expect(screen.getByText(/24-hour window from the customer’s last message/)).toBeVisible();
    fireEvent.change(screen.getByLabelText('Message 1 wait'), { target: { value: '24' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Shorten the delay or choose an approved template');
    expect(read().followUps.sequences[0].steps[0].messageMode).toBe('ai');
    fireEvent.change(screen.getByLabelText('Message 1 content'), { target: { value: 'template' } });
    expect(screen.getByRole('button', { name: 'Message 1 template' })).toBeVisible();
    expect(screen.getByText(/Choose an approved template before saving/)).toBeVisible();
  });
  it('applies a weekday schedule and retains it when returning to always available', () => {
    const initial = draft(); initial.availability.timezone = 'Asia/Kolkata';
    mount('availability', initial);
    fireEvent.click(screen.getByRole('radio', { name: /Weekly schedule/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Use weekdays 9–5' }));
    expect(read().availability.weekly.filter(day => day.ranges.length)).toHaveLength(5);
    expect(read().availability.timezone).toBe('Asia/Kolkata');
    fireEvent.click(screen.getByRole('radio', { name: /Always available/ }));
    expect(read().availability.enabled).toBe(false); expect(read().availability.weekly).toHaveLength(7);
  });
  it('offers AI email follow-ups without requiring a template or applying the WhatsApp window', () => {
    const initial = draft(); initial.bindings = [{ channel: 'email', surface: 'private', accountId: 'support@example.com' }];
    mount('followups', initial);
    fireEvent.click(screen.getByRole('radio', { name: /Schedule check-ins/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Email' }));
    fireEvent.change(screen.getByLabelText('Message 1 content'), { target: { value: 'ai' } });
    expect(read().followUps.sequences[0]).toEqual({ channel: 'email', steps: [{ delayMinutes: 60, templateId: 0, messageMode: 'ai' }] });
    expect(screen.getByText(/Uses your assistant email design and original sending account/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Message 1 template' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Message 1 wait'), { target: { value: '48' } });
    expect(read().followUps.sequences[0].steps[0].delayMinutes).toBe(2880);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
