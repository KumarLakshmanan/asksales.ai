import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantSimulator } from '@/components/outreach/assistants/AssistantSimulator';
import { AssistantTraceView } from '@/components/outreach/assistants/AssistantTraceView';
import { scenarioAssertions, type AssistantTrace } from '@/lib/assistant-simulator';
import { emptyAssistantDraft, type OutreachAssistant } from '@/lib/outreach-assistants';
import type { useAssistantWorkspace } from '@/hooks/use-outreach-assistants';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: { get: mocks.get, post: mocks.post } }));
vi.mock('@/hooks/use-outreach-assistants', () => ({ ASSISTANT_API: '/api/settings/outreach/assistants' }));
const assistant: OutreachAssistant = {
  id: 'synthetic-assistant', businessProfileId: 1, draft: emptyAssistantDraft(), draftVersion: 1,
  published: emptyAssistantDraft(), publishedRevision: 3, state: 'draft',
  readiness: { ready: false, checks: [] }, updatedAt: '2026-10-27T00:00:00Z',
};
const workspace = {
  profileId: 1, scopeKey: ['outreach-assistants', 1, 1], requestOptions: { headers: { 'X-Business-Profile-Id': '1' } },
  catalog: { data: { runtimeEnabled: false, accounts: [], permissions: { canManage: false } } },
} as unknown as ReturnType<typeof useAssistantWorkspace>;
const trace = (reply = 'No approved source was found.', revision = 0): AssistantTrace => ({
  reply, outcome: 'auto_sent', sideEffectsSuppressed: true, conversationId: -10, previewSessionToken: 'synthetic-signed-session',
  resolvedAssistant: { assistantId: assistant.id, revision, configurationMode: revision === 0 ? 'draft' : 'published' },
  privacyOutcome: { mandatory: true, redactedInput: 'Synthetic test' }, stages: [],
});
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ items: [] });
  mocks.post.mockResolvedValue(trace());
});

describe('assistant simulator configuration and outcome labels', () => {
  it.each(['instagram', 'email', 'web', 'whatsapp', 'facebook'])(
    'labels %s as an isolated channel simulation and identifies the selected saved draft', async channel => {
      render(<AssistantSimulator assistant={assistant} workspace={workspace} dirty={false} />, { wrapper });
      expect(screen.getByText('Simulates channel behavior; account connections and assignments are not verified.')).toBeVisible();
      expect(screen.getByLabelText('Test channel')).toHaveAccessibleDescription('Simulates channel behavior; account connections and assignments are not verified.');
      fireEvent.change(screen.getByLabelText('Test channel'), { target: { value: channel } });
      fireEvent.change(screen.getByLabelText('Test customer message'), { target: { value: 'Synthetic test' } });
      fireEvent.click(screen.getByRole('button', { name: 'Test saved configuration' }));
      expect(await screen.findByText('Simulated outcome · Reply generated · No side effects')).toBeVisible();
      expect(screen.getByText('Selected configuration').nextElementSibling).toHaveTextContent('Saved draft v1');
      expect(screen.getByText('Resolved configuration').nextElementSibling).toHaveTextContent(/^Saved draft$/);
      const advanced = screen.getByText('Advanced trace details').parentElement!;
      expect(advanced.textContent).toMatch(/"revision":\s*0/);
      expect(advanced.textContent).toMatch(/"outcome":\s*"auto_sent"/);
      expect(mocks.post).toHaveBeenCalledWith('/api/settings/outreach/assistants/synthetic-assistant/simulate',
        expect.objectContaining({ channel, revision: 'draft' }), workspace.requestOptions);
      expect(mocks.post.mock.calls.every(([url]) => url.endsWith('/simulate'))).toBe(true);
      expect(mocks.post.mock.calls[0][1]).not.toHaveProperty('selectedConfiguration');
    },
  );

  it('distinguishes the selected and resolved published revision', async () => {
    mocks.post.mockResolvedValue(trace('Published preview', 3));
    render(<AssistantSimulator assistant={assistant} workspace={workspace} dirty={false} />, { wrapper });
    fireEvent.change(screen.getByLabelText('Version to test'), { target: { value: 'published' } });
    fireEvent.change(screen.getByLabelText('Test customer message'), { target: { value: 'Synthetic test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test saved configuration' }));
    await screen.findByText('Published preview');
    expect(screen.getByText('Selected configuration').nextElementSibling).toHaveTextContent('Published r3');
    expect(screen.getByText('Resolved configuration').nextElementSibling).toHaveTextContent('Published r3');
  });

  it('does not relabel a stale result as a newly saved draft version', async () => {
    let resolve!: (value: AssistantTrace) => void;
    mocks.post.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const view = render(<AssistantSimulator assistant={assistant} workspace={workspace} dirty={false} />, { wrapper });
    fireEvent.change(screen.getByLabelText('Test customer message'), { target: { value: 'Synthetic test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test saved configuration' }));
    view.rerender(<AssistantSimulator assistant={{ ...assistant, draftVersion: 2 }} workspace={workspace} dirty={false} />);
    await act(async () => resolve(trace('Old draft result')));
    expect(screen.queryByText('Old draft result')).not.toBeInTheDocument();
    mocks.post.mockResolvedValueOnce(trace('Current draft result'));
    fireEvent.click(screen.getByRole('button', { name: 'Test saved configuration' }));
    await screen.findByText('Current draft result');
    expect(screen.getByText('Selected configuration').nextElementSibling).toHaveTextContent('Saved draft v2');
  });

  it('does not invent a version when a historical draft trace lacks request context', () => {
    render(<AssistantTraceView trace={trace()} />);
    expect(screen.getByText('Resolved configuration').nextElementSibling).toHaveTextContent(/^Saved draft$/);
    expect(screen.queryByText('Selected configuration')).not.toBeInTheDocument();
    expect(screen.queryByText('Revision')).not.toBeInTheDocument();
  });

  it('does not claim suppression when it was not recorded', () => {
    render(<AssistantTraceView trace={{ ...trace(), sideEffectsSuppressed: undefined }} />);
    expect(screen.getByText('Simulated outcome · Reply generated')).toBeVisible();
    expect(screen.queryByText(/No side effects/)).not.toBeInTheDocument();
  });

  it('keeps raw scenario outcomes unchanged while labelling them simulated', async () => {
    render(<AssistantSimulator assistant={assistant} workspace={workspace} dirty={false} />, { wrapper });
    fireEvent.change(screen.getByLabelText('Customer messages (one per line)'), { target: { value: 'Synthetic test' } });
    fireEvent.change(screen.getByLabelText('Expected final outcome (optional)'), { target: { value: 'auto_sent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run scenario' }));
    expect(await screen.findByText('Message 1 · Reply generated · Simulated')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Saved draft v1', { selector: 'h3' })).toBeInTheDocument());
    expect(screen.getByRole('list', { name: 'Scenario checks' })).toHaveTextContent('Passed · Simulated final outcome is auto_sent');
    expect(scenarioAssertions({ replyIncludes: [], outcome: 'auto_sent', playbookId: null }, trace())[0].passed).toBe(true);
  });
});
