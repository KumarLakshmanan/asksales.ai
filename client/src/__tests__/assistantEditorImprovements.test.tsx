import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { emptyAssistantDraft, type AssistantCatalog, type OutreachAssistant } from '@/lib/outreach-assistants';
import { assistantRevisionChanges, assistantSetupSections, previewPlaybookAssignments, recoverableAssistantDraft, restoreAssistantDraft, RECOVERY_TTL } from '@/components/outreach/assistants/assistantEditorUtils';
import { ReadinessChecks, ResourceSelection } from '@/components/outreach/assistants/AssistantShared';
import { AssistantPolicyEditor } from '@/components/outreach/assistants/AssistantPolicyEditor';
import { AssistantTemplatePreview } from '@/components/outreach/assistants/AssistantTemplatePreview';
import { AssistantRevisionHistory } from '@/components/outreach/assistants/AssistantRevisionHistory';
import { useAssistantDraftRecovery } from '@/components/outreach/assistants/useAssistantDraftRecovery';
import { useAssistantEditorGuard } from '@/components/outreach/assistants/useAssistantEditorGuard';
import { AssistantSetupGuide, leaveUnconfiguredResourcesUnused } from '@/components/outreach/assistants/AssistantSetupGuide';
import type { useAssistantWorkspace } from '@/hooks/use-outreach-assistants';
import api from '@/lib/api';

vi.mock('@/lib/api', () => ({ ApiError: class extends Error {}, default: { get: vi.fn(), post: vi.fn() } }));
afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); vi.clearAllMocks(); });
const catalog: AssistantCatalog = { runtimeEnabled: true, presets: [], accounts: [], models: [], knowledge: [], playbooks: [], templates: [], documents: [], galleries: [], tools: [], permissions: { canManage: true, description: '' } };
const draft = () => ({ ...emptyAssistantDraft(), name: 'Original name', instructions: 'Private instructions', description: 'Private description', demonstrations: [{ customer: 'customer@example.test', assistant: 'Private demonstration' }] });

describe('assistant recovery and routing checks', () => {
  it('does not put free text or a personal-data-like intent in browser recovery', () => {
    const source = draft();
    source.policies = { rules: [{ disclaimer: 'Private policy' }] };
    source.availability.awayMessage = 'Private away text';
    source.privacy.uncertaintyMessage = 'Private uncertainty text';
    source.playbooks.assignments = [{ playbookId: 1, channel: 'web', surface: 'private', intent: 'customer@example.test', priority: 1 }];
    const stored = JSON.stringify(recoverableAssistantDraft(source));
    expect(stored).not.toMatch(/Private|customer@example|Original name/);
    const restored = restoreAssistantDraft(source, { ...recoverableAssistantDraft(source), instructions: 'Injected instructions', name: 'Injected name' });
    expect(restored?.instructions).toBe(source.instructions);
    expect(restored?.name).toBe(source.name);
    expect(restored?.demonstrations).toEqual(source.demonstrations);
  });
  it('rejects corrupt structural selections and unknown timezone', () => {
    expect(restoreAssistantDraft(draft(), { ...recoverableAssistantDraft(draft()), bindings: [null] })).toBeNull();
    expect(restoreAssistantDraft(draft(), { ...recoverableAssistantDraft(draft()), availability: { enabled: true, timezone: 'unknown', weekly: [] } })).toBeNull();
  });
  it('orders exact intent before any-intent, then lower priority and playbook ID', () => {
    const source = draft(); source.playbooks = { mode: 'selected', assignments: [
      { playbookId: 1, channel: 'web', surface: 'private', intent: null, priority: 0 },
      { playbookId: 9, channel: 'web', surface: 'private', intent: 'booking', priority: 100 },
      { playbookId: 3, channel: 'web', surface: 'private', intent: 'booking', priority: 100 },
      { playbookId: 2, channel: 'email', surface: 'private', intent: 'booking', priority: 0 },
    ] };
    expect(previewPlaybookAssignments(source, 'web', 'private', 'booking').map(a => a.playbookId)).toEqual([3, 9, 1]);
    expect(previewPlaybookAssignments(source, 'web', 'public_comment', 'booking')).toEqual([]);
  });
  it('offers the brochure FAQ candidate only for confirmed brochure information requests', () => {
    const source = draft(); source.playbooks = { mode: 'selected', assignments: [
      { playbookId: 1, channel: 'web', surface: 'private', intent: null, priority: 0 },
      { playbookId: 2, channel: 'web', surface: 'private', intent: 'faq', priority: 100 },
    ] };
    expect(previewPlaybookAssignments(source, 'web', 'private', 'brochure', true).map(a => a.playbookId)).toEqual([2, 1]);
    expect(previewPlaybookAssignments(source, 'web', 'private', 'brochure').map(a => a.playbookId)).toEqual([1]);
  });
  it('links unresolved knowledge and follow-up choices to the correct setup section', () => {
    const setup = assistantSetupSections(draft(), catalog);
    expect(setup.find(s => s.tab === 'knowledge')?.issues).toContain('Choose resources or None for knowledge sources.');
    expect(setup.find(s => s.tab === 'followups')?.issues).toContain('Choose resources or None for follow-up sequences.');
    expect(assistantRevisionChanges(draft(), { ...draft(), instructions: 'Changed' })).toEqual(['instructions']);
  });
});

describe('guided assistant configuration', () => {
  it('announces which readiness checks passed or need attention without relying on icons', () => {
    render(<ReadinessChecks readiness={{ ready: false, checks: [
      { key: 'knowledge', label: 'Knowledge', ok: true, detail: 'Published sources are permitted.' },
      { key: 'accounts', label: 'Connected accounts', ok: false, detail: 'Reconnect the missing account.' },
    ] }} />);
    expect(screen.getByRole('listitem', { name: 'Knowledge — Passed' })).toHaveTextContent('Published sources are permitted.');
    expect(screen.getByRole('listitem', { name: 'Connected accounts — Needs attention' })).toHaveTextContent('Reconnect the missing account.');
  });
  it('leaves undecided resources unused only after an explicit action and preserves selected resources', () => {
    const source = draft();
    source.knowledge = { mode: 'selected', ids: [12] };
    source.tools = { mode: 'selected', names: ['create_proposal'], approvalRequired: ['create_proposal'] };
    const change = vi.fn();
    render(<AssistantSetupGuide draft={source} catalog={catalog} disabled={false} onChange={change} onNavigate={vi.fn()} onTest={vi.fn()} history={null} />);
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Leave optional resources unused'));
    fireEvent.click(screen.getByRole('button', { name: 'Leave these unused' }));
    const next = change.mock.calls[0][0];
    expect(next.knowledge).toEqual(source.knowledge);
    expect(next.tools).toEqual(source.tools);
    expect(next.followUps).toEqual({ mode: 'none', sequences: [] });
    expect(next.documents).toEqual({ mode: 'none', ids: [] });
    expect(source.documents.mode).toBe('unconfigured');
    expect(leaveUnconfiguredResourcesUnused(next)).toEqual(next);
  });
  it('keeps the knowledge tool when undecided tools are left unused but knowledge is selected', () => {
    const source = draft();
    source.knowledge = { mode: 'selected', ids: [12] };
    expect(leaveUnconfiguredResourcesUnused(source).tools).toEqual({ mode: 'selected', names: ['answer_from_knowledge_base'], approvalRequired: [] });
    expect(leaveUnconfiguredResourcesUnused(draft()).tools).toEqual({ mode: 'none', names: [], approvalRequired: [] });
  });
  it('guides to the first incomplete section without exposing another expanded navigation grid', () => {
    const navigate = vi.fn();
    render(<AssistantSetupGuide draft={draft()} catalog={catalog} disabled onChange={vi.fn()} onNavigate={navigate} onTest={vi.fn()} history={null} />);
    expect(screen.getByRole('progressbar', { name: 'Assistant setup' })).toHaveAttribute('aria-valuemax', '8');
    fireEvent.click(screen.getByRole('button', { name: 'Continue setup: Identity & accounts' }));
    expect(navigate).toHaveBeenCalledWith('basic');
    expect(screen.queryByText('View all setup sections')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Leave optional resources unused'));
    expect(screen.getByRole('button', { name: 'Leave these unused' })).toBeDisabled();
  });
  it('bounds rendered resources and retains selections across pages',()=>{
    const resources=Array.from({length:80},(_,index)=>({id:index+1,name:`Source ${index+1}`,channels:['web']}));
    const change=vi.fn();
    render(<ResourceSelection label="Knowledge sources" resources={resources} value={{mode:'selected',ids:[1]}} onChange={change} />);
    expect(screen.getAllByRole('checkbox')).toHaveLength(25);
    expect(screen.queryByText('Source 26',{exact:true})).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Next resources'}));
    fireEvent.click(screen.getByRole('checkbox',{name:/Source 26/}));
    expect(change).toHaveBeenCalledWith({mode:'selected',ids:[1,26]});
    fireEvent.change(screen.getByLabelText('Search knowledge sources'),{target:{value:'Source 80'}});
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.getByText('Source 80',{exact:true})).toBeVisible();
  });
  it('retains selections hidden by resource search and shows unavailable explanations', () => {
    const onChange = vi.fn();
    render(<ResourceSelection label="Knowledge sources" resources={[{ id: 1, name: 'Booking policy', channels: ['web'], preview: 'Published policy text.' }, { id: 2, name: 'Menu', channels: ['web'] }]} unavailableResources={[{ id: 3, name: 'Draft brochure', channels: ['web'], availabilityReason: 'Publish this source first.' }]} value={{ mode: 'selected', ids: [1] }} onChange={onChange} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search knowledge sources' }), { target: { value: 'Menu' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Menu/ }));
    expect(onChange).toHaveBeenCalledWith({ mode: 'selected', ids: [1, 2] });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search knowledge sources' }), { target: { value: '' } });
    expect(screen.getByText('Publish this source first.')).toBeInTheDocument();
  });
  it('starts with guided supported policies and retains wrapper metadata', () => {
    const change = vi.fn();
    render(<AssistantPolicyEditor value={{ escalationNote: 'Retain metadata', rules: [] }} onChange={change} onValidity={vi.fn()} />);
    expect(screen.queryByLabelText('Advanced policy JSON')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Add policy rule'), { target: { value: 'rate_limit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(change).toHaveBeenCalledWith(expect.objectContaining({ escalationNote: 'Retain metadata', rules: [expect.objectContaining({ type: 'rate_limit', config: { limit: 30, windowSeconds: 60, action: 'block' } })] }));
  });
  it('blocks saving invalid advanced JSON until repaired', () => {
    const validity = vi.fn();
    render(<AssistantPolicyEditor value={{ rules: [] }} onChange={vi.fn()} onValidity={validity} />);
    fireEvent.click(screen.getByRole('button', { name: 'Advanced JSON' }));
    fireEvent.change(screen.getByLabelText('Advanced policy JSON'), { target: { value: '{ invalid' } });
    expect(validity).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('button', { name: 'Return to guided policies' })).toBeDisabled();
  });
  it('previews sample variables without sending and explains unknown variables', () => {
    render(<AssistantTemplatePreview channel="WhatsApp" template={{ id: 5, name: 'Guest check-in', channels: ['whatsapp'], preview: 'Hi {{first_name}}, {{unapproved_token}}', variables: ['first_name', 'unapproved_token'], status: 'approved' }} />);
    fireEvent.click(screen.getByText('Preview Guest check-in · WhatsApp'));
    expect(screen.getByRole('alert')).toHaveTextContent('Unsupported variables: unapproved_token');
    fireEvent.change(screen.getByLabelText('Sample first_name'), { target: { value: 'Fictional guest' } });
    expect(screen.getByText('Hi Fictional guest, {{unapproved_token}}')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });
});

function RecoveryHarness({ version = 1, scope = ['assistants', 7, 9] }: { version?: number; scope?: unknown[] }) {
  const [saved] = useState(draft);
  const [current, setCurrent] = useState(saved);
  const recovery = useAssistantDraftRecovery({ scope, assistantId: 'test-assistant', version, draft: current, saved, dirty: JSON.stringify(current) !== JSON.stringify(saved), onRestore: setCurrent });
  return <>{recovery.banner}<p>Recovered model: {current.replyModel?.model || 'none'}</p></>;
}
describe('recovery boundaries and leave guard', () => {
  it('requires explicit restore and is scoped to user, business, assistant and saved version', () => {
    sessionStorage.setItem('assistant-draft:7:9:test-assistant', JSON.stringify({ at: Date.now(), version: 1, value: recoverableAssistantDraft({ ...draft(), replyModel: { provider: 'openai', model: 'saved-model' } }) }));
    render(<RecoveryHarness />);
    expect(screen.getByText('Recovered model: none')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restore configuration' }));
    expect(screen.getByText('Recovered model: saved-model')).toBeInTheDocument();
  });
  it('discards expired and superseded recovery copies', () => {
    const key = 'assistant-draft:7:9:test-assistant';
    sessionStorage.setItem(key, JSON.stringify({ at: Date.now() - RECOVERY_TTL - 1, version: 1, value: recoverableAssistantDraft(draft()) }));
    const view = render(<RecoveryHarness />);
    expect(sessionStorage.getItem(key)).toBeNull();
    view.unmount();
    sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), version: 1, value: recoverableAssistantDraft(draft()) }));
    render(<RecoveryHarness version={2} />);
    expect(sessionStorage.getItem(key)).toBeNull();
  });
  it('does not load another user or profile recovery copy', () => {
    sessionStorage.setItem('assistant-draft:7:9:test-assistant', JSON.stringify({ at: Date.now(), version: 1, value: recoverableAssistantDraft(draft()) }));
    render(<RecoveryHarness scope={['assistants', 8, 10]} />);
    expect(screen.queryByRole('button', { name: 'Restore configuration' })).not.toBeInTheDocument();
  });
  it('blocks a link navigation when the person declines losing unsaved text', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    function Harness() { useAssistantEditorGuard(true, false); return <a href="/dashboard/home">Leave editor</a>; }
    render(<Harness />);
    expect(fireEvent.click(screen.getByRole('link', { name: 'Leave editor' }))).toBe(false);
    expect(window.confirm).toHaveBeenCalled();
  });
});

describe('published revision review', () => {
  it('loads history only when opened and requires review plus assignment confirmation before rollback', async () => {
    const ready = draft();
    ready.agentType = 'hotel_sales'; ready.replyModel = { provider: 'openai', model: 'model' }; ready.bindings = [{ channel: 'web', surface: 'private', accountId: 'widget' }];
    ready.knowledge = { mode: 'none', ids: [] }; ready.documents = { mode: 'none', ids: [] }; ready.galleries = { mode: 'none', ids: [] };
    ready.playbooks = { mode: 'none', assignments: [] }; ready.followUps = { mode: 'none', sequences: [] }; ready.tools = { mode: 'none', names: [], approvalRequired: [] };
    const assistant: OutreachAssistant = { id: 'assistant', businessProfileId: 9, state: 'live', draft: ready, published: ready, draftVersion: 4, publishedRevision: 2, updatedAt: '', readiness: { ready: true, checks: [] } };
    const localCatalog: AssistantCatalog = { ...catalog, presets: [{ agentType: 'hotel_sales', name: 'Hotel', description: '', instructions: '', tools: [], policies: {} }], models: [{ provider: 'openai', model: 'model', label: 'Model', controls: [] }], accounts: [{ ...ready.bindings[0], label: 'Widget', connected: true, assignedAssistantId: 'another-assistant' }] };
    const workspace = { scopeKey: ['assistants', 7, 9], requestOptions: { headers: { 'X-Business-Profile-Id': '9' } } } as unknown as ReturnType<typeof useAssistantWorkspace>;
    vi.mocked(api.get).mockResolvedValue({ items: [{ revision: 1, publishedAt: '2026-10-01T00:00:00Z', current: false, configuration: { ...ready, instructions: 'Previous instructions' } }], nextCursor: null });
    vi.mocked(api.post).mockResolvedValue(assistant);
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AssistantRevisionHistory assistant={assistant} catalog={localCatalog} workspace={workspace} disabled={false} onAccept={vi.fn().mockResolvedValue(undefined)} /></QueryClientProvider>);
    expect(api.get).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Revision history' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Compare & review rollback' }));
    expect(screen.getByRole('button', { name: 'Publish reviewed rollback' })).toBeDisabled();
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Publish reviewed rollback' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/settings/outreach/assistants/assistant/rollback', { revision: 1, expectedDraftVersion: 4, confirmAssignments: true, reassign: true }, workspace.requestOptions));
  });
});
