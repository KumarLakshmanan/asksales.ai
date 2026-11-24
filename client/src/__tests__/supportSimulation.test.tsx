import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Operations from '@/app/dashboard/(main)/settings/outreach/orchestration/page';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: { get: mocks.get, post: mocks.post } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/support/ConversationRecovery', () => ({ ConversationRecovery: () => null }));
vi.mock('@/components/support/ApprovalResumeRecovery', () => ({ ApprovalResumeRecovery: () => null }));
vi.mock('@/components/support/PrivacyAccessHistory', () => ({ PrivacyAccessHistory: () => null }));

vi.mock('@/hooks/use-outreach-assistants', () => ({
  useAssistantWorkspace: () => ({ profileId: 1, scopeKey: ['outreach-assistants', 9, 1], profiles: { isLoading: false }, requestOptions: { headers: { 'X-Business-Profile-Id': '1' } } }),
  useAssistantList: () => ({ data: { runtimeEnabled: true, assistants: [{ id: 'qa-assistant', draft: { name: 'QA assistant' }, publishedRevision: 2 }] } }),
}));
const report = {
  outcomes: [], delivery: [], handoffs: [], playbooks: [], tools: [], privacyAccess: [],
  knowledgeGaps: [], guardrails: [], adminAudit: [],
  privacy: { retained_records: 0, expiring_within_7_days: 0, configured: true },
  csat: { responses: 0, average_rating: null },
  readiness: { llm: true, privacyVault: true },
};
const question = 'QA ONLY: Please explain the support process. Do not contact any customer.';
const blocked = 'Assistant replies are disabled. No legacy agent fallback is permitted.';
const success = {
  success: true, outcome: 'auto_sent', previewSessionId: -1709404692,
  replyText: 'Suggested support process.', confidence: 0.9, sideEffectsSuppressed: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '#simulator';
  mocks.get.mockImplementation(async (path: string) => path.includes('orchestration-report') ? report : []);
});

async function preview() {
  const user = userEvent.setup();
  render(<Operations />);
  await screen.findByRole('heading', { name: 'Test a reply safely' });
  fireEvent.change(screen.getByRole('combobox', { name: 'Simulation assistant' }), { target: { value: 'qa-assistant' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Simulation channel' }), { target: { value: 'email' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Customer test message' }), { target: { value: question } });
  await user.click(screen.getByRole('button', { name: 'Preview reply safely' }));
  return user;
}

describe('support reply simulation responses', () => {
  it('requires an assistant and sends the selected published revision', async () => {
    mocks.post.mockResolvedValue(success);
    const user = userEvent.setup();
    render(<Operations />);
    await screen.findByRole('heading', { name: 'Test a reply safely' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Customer test message' }), { target: { value: question } });
    expect(screen.getByRole('button', { name: 'Preview reply safely' })).toBeDisabled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Simulation assistant' }), { target: { value: 'qa-assistant' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Simulation configuration' }), { target: { value: 'published' } });
    await user.click(screen.getByRole('button', { name: 'Preview reply safely' }));
    await screen.findByText('90% composite confidence');
    expect(mocks.post).toHaveBeenCalledWith('/api/support/ai/simulate', expect.objectContaining({
      assistantId: 'qa-assistant', assistantRevision: 'published',
    }), expect.objectContaining({ headers: expect.any(Object) }));
    expect(screen.getByRole('combobox', { name: 'Simulation assistant' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Simulation configuration' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Start a new test' }));
    expect(screen.getByRole('combobox', { name: 'Simulation assistant' })).toBeEnabled();
    expect(screen.getByRole('combobox', { name: 'Simulation configuration' })).toBeEnabled();
  });
  it.each([
    { success: false, outcome: 'no_op', error: blocked, code: 'SUPPORT_ASSISTANT_UNAVAILABLE', sideEffectsSuppressed: true },
    { success: false, outcome: 'no_op', error: 'An error occurred', sideEffectsSuppressed: true },
  ])('keeps a terminal blocked/error envelope out of successful preview state (%j)', async response => {
    mocks.post.mockResolvedValue(response);
    await preview();
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Simulation failed', description: response.error })));
    expect(screen.getByRole('textbox', { name: 'Customer test message' })).toHaveValue(question);
    expect(screen.getByRole('combobox', { name: 'Simulation channel' })).toHaveValue('email');
    expect(screen.getByRole('button', { name: 'Preview reply safely' })).toBeEnabled();
    expect(screen.queryByText('Proposed response')).not.toBeInTheDocument();
    expect(screen.queryByText(/Test conversation \(/)).not.toBeInTheDocument();
  });

  it.each([null, undefined, {}, { ...success, piiTypes: {} }, { ...success, outcome: undefined },
    { ...success, agentType: {} }, { ...success, sideEffectsSuppressed: undefined },
    { ...success, previewSessionId: 12 }])('retains the question on an incomplete preview response (%j)', async response => {
    mocks.post.mockResolvedValue(response);
    await preview();
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Simulation failed', description: expect.stringContaining('incomplete response') })));
    expect(screen.getByRole('textbox', { name: 'Customer test message' })).toHaveValue(question);
    expect(screen.queryByText('Proposed response')).not.toBeInTheDocument();
  });

  it('retains the question and request context when the API rejects', async () => {
    mocks.post.mockRejectedValue(new Error(blocked));
    await preview();
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ description: blocked })));
    expect(screen.getByRole('textbox', { name: 'Customer test message' })).toHaveValue(question);
    expect(mocks.post).toHaveBeenCalledWith('/api/support/ai/simulate', expect.objectContaining({
      message: question, channel: 'email', assistantId: 'qa-assistant', assistantRevision: 'draft', mockProfile: { knownName: false },
    }), expect.any(Object));
  });

  it('renders successful previews with optional diagnostics omitted and continues only their isolated session', async () => {
    mocks.post.mockResolvedValue(success);
    const user = await preview();
    expect((await screen.findAllByText('Suggested support process.')).length).toBeGreaterThan(0);
    expect(screen.getByText('90% composite confidence')).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Customer test message' })).toHaveValue('');
    expect(screen.getByText('Test conversation (1 turns)')).toBeVisible();
    fireEvent.change(screen.getByRole('textbox', { name: 'Customer test message' }), { target: { value: 'Follow-up test' } });
    await user.click(screen.getByRole('button', { name: 'Preview reply safely' }));
    expect(mocks.post).toHaveBeenLastCalledWith('/api/support/ai/simulate', expect.objectContaining({ previewSessionId: -1709404692, channel: 'email', assistantId: 'qa-assistant', assistantRevision: 'draft' }), expect.any(Object));
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('renders complete successful diagnostics without changing the preview request mode', async () => {
    mocks.post.mockResolvedValue({ ...success, piiTypes: ['name'], agentType: 'support',
      playbook: { playbookId: 5, version: 2, nodeId: 'answer' },
      toolCalls: [{ toolName: 'read_knowledge' }], policyViolations: [],
    });
    await preview();
    expect(await screen.findByText('Redacted before models: name')).toBeVisible();
    expect(screen.getByText(/Playbook #5 v2/)).toBeVisible();
    expect(mocks.post.mock.calls.every(([path]) => path === '/api/support/ai/simulate')).toBe(true);
  });

  it('keeps an unsuccessful follow-up out of history and clears the previous result panel', async () => {
    mocks.post.mockResolvedValueOnce(success).mockResolvedValueOnce({ success: false, outcome: 'no_op', error: blocked });
    const user = await preview();
    await screen.findByText('90% composite confidence');
    fireEvent.change(screen.getByRole('textbox', { name: 'Customer test message' }), { target: { value: 'Unanswered follow-up' } });
    await user.click(screen.getByRole('button', { name: 'Preview reply safely' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ description: blocked })));
    expect(screen.getByRole('textbox', { name: 'Customer test message' })).toHaveValue('Unanswered follow-up');
    expect(screen.getByText('Test conversation (1 turns)')).toBeInTheDocument();
    expect(screen.queryByText('90% composite confidence')).not.toBeInTheDocument();
    expect(screen.queryByText('Proposed response')).not.toBeInTheDocument();
  });
});
