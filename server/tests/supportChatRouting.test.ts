import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { withBusinessScope } from '../tenancy/businessContext.js';

const select = jest.fn(), insert = jest.fn(), execute = jest.fn();
const handle = jest.fn();
const assistantRow = jest.fn<(...args: any[]) => Promise<any>>();
const run = jest.fn();
const update = jest.fn(() => ({ set: () => ({ where: async () => [] }) }));
jest.unstable_mockModule('../models/db.js', () => ({ db: { select, insert, execute, update } }));
jest.unstable_mockModule('../services/agents/AgentRouter.js', () => ({ agentRouter: { handle } }));
jest.unstable_mockModule('../services/assistants/AssistantService.js', () => ({ assistantRow }));
jest.unstable_mockModule('../services/assistants/AssistantCatalogService.js', () => ({
  assistantCatalog: jest.fn(), assistantPlatformReadiness: jest.fn(),
}));
jest.unstable_mockModule('../services/assistants/AssistantConfiguration.js', () => ({
  parseAssistantDraft: (source: unknown) => source, assistantReadiness: jest.fn(), withinAssistantHours: jest.fn(),
}));
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({
  redactPiiWithStableTokens: (text: string) => ({ redactedText: text }),
}));
const { conversationRequests, ConversationRequestError } = await import('../services/ConversationRequestCoordinator.js');
const { ownerSupportChat } = await import('../controllers/ownerSupportAIController.js');
const { requireSupportChatAssistant } = await import('../services/SupportChatRouting.js');
const { resolveTurnAssistant } = await import('../services/assistants/AssistantResolver.js');
const { AssistantManagementError } = await import('../services/assistants/AssistantManagementError.js');

const previousEnabled = process.env.SUPPORT_ASSISTANTS_ENABLED;
const previousProfiles = process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES;
const scope = (work: () => Promise<any>) => withBusinessScope({ userId: 1, businessProfileId: 1 }, work);
function response() {
  const res: any = { statusCode: 200 };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  return res;
}
const message = { userId: 1, conversationId: -1000000088, channel: 'web' as const,
  senderIdentifier: 'owner:1', inboundText: '', metadata: { executionMode: 'advisory' as const, conversationKind: 'owner_support' } };

describe('Support AI configuration failure boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPPORT_ASSISTANTS_ENABLED = 'false';
    delete process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES;
    jest.spyOn(conversationRequests, 'run').mockImplementation(run as any);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (previousEnabled === undefined) delete process.env.SUPPORT_ASSISTANTS_ENABLED;
    else process.env.SUPPORT_ASSISTANTS_ENABLED = previousEnabled;
    if (previousProfiles === undefined) delete process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES;
    else process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES = previousProfiles;
  });
  it.each([undefined, '88'])('reports the real disabled-runtime cause for session %s without a fake reply or durable turn', async sessionId => {
    const res = response();
    await scope(() => ownerSupportChat({ user: { id: 1 }, body: { message: 'Which published refund policy is available?', sessionId, requestId: 'qa-routing-001' } } as any, res));
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: 'support_assistant_unavailable', error: expect.stringContaining('Assistant replies are disabled') });
    expect(res.body.error).toContain('Manage assistants');
    expect(res.body).not.toHaveProperty('data.assistantMessage');
    expect(select).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled(); expect(handle).not.toHaveBeenCalled();
  });
  it('gives an actionable selection error when rollout is enabled but no assistant was selected', async () => {
    process.env.SUPPORT_ASSISTANTS_ENABLED = 'true';
    await expect(scope(() => requireSupportChatAssistant(message))).rejects.toMatchObject({
      code: 'support_assistant_unavailable', statusCode: 409, message: expect.stringContaining('Select an assistant'),
    });
  });
  it.each(['draft', 'published'])('allows explicitly selected %s simulations while live replies remain disabled', async revision => {
    assistantRow.mockResolvedValue({ id: 'scoped-assistant', published_revision: 3,
      draft: { bindings: [], name: 'Draft' }, published: { bindings: [], name: 'Published' } });
    await expect(scope(() => requireSupportChatAssistant({ ...message, metadata: { ...message.metadata,
      simulationAssistantId: 'scoped-assistant', simulationRevision: revision } }))).resolves.toBeUndefined();
    expect(assistantRow).toHaveBeenCalledWith('scoped-assistant');
    await expect(scope(() => resolveTurnAssistant({ ...message, metadata: { executionMode: 'customer' } }))).rejects.toThrow('Assistant replies are disabled');
  });
  it('does not substitute another assistant when the selection is unauthorized or unpublished', async () => {
    assistantRow.mockRejectedValueOnce(new AssistantManagementError('Assistant not found.', 404));
    const selected = { ...message, metadata: { ...message.metadata, simulationAssistantId: 'unavailable', simulationRevision: 'published' } };
    await expect(scope(() => requireSupportChatAssistant(selected))).rejects.toBeInstanceOf(ConversationRequestError);
    assistantRow.mockResolvedValueOnce({ id: 'unavailable', draft: { bindings: [] }, published: null });
    await expect(scope(() => requireSupportChatAssistant(selected))).rejects.toMatchObject({
      code: 'support_assistant_unavailable', message: expect.stringContaining('No published assistant revision'),
    });
    expect(handle).not.toHaveBeenCalled();
  });
  it.each([
    { answer: 'The published policy allows returns within 14 days.', sources: [{ sourceId: 7, citation: '[KB-7]', title: 'Returns', excerpt: '14 days', similarity: 0.99 }] },
    { answer: 'No published return or refund policy is available in the selected knowledge.', sources: [] },
  ])('continues to persist an actual generated answer and its source evidence: $answer', async ({ answer, sources }) => {
    assistantRow.mockResolvedValue({ id: 'scoped-assistant', published_revision: 3, published: { bindings: [] } });
    const history = [{ id: 91, role: 'user', content: 'Which refund policy is published?', metadata: {} }];
    const selected = [[{ id: 1 }], [{ id: 2 }], history, [{ metadata: {} }]];
    select.mockImplementation(() => {
      const result = selected.shift();
      const chain: any = { then: (resolve: any) => Promise.resolve(result).then(resolve) };
      for (const key of ['from', 'where', 'limit', 'orderBy']) chain[key] = () => chain;
      return chain;
    });
    const saved: any[] = [];
    insert.mockImplementation(() => ({ values: (value: any) => {
      saved.push(value);
      const chain = { returning: async () => [{ id: saved.length === 1 ? 88 : 90 + saved.length, ...value }] };
      return { ...chain, onConflictDoNothing: () => chain };
    } }));
    run.mockImplementation((_identity: any, generate: any) => generate());
    handle.mockImplementation(async () => ({ replyText: answer, deliveryOutcome: 'auto_sent', confidence: sources.length ? 0.99 : 0,
      kbSourcesUsed: sources, answerVerification: { mayDeliver: true } }));
    const res = response();
    await scope(() => ownerSupportChat({ user: { id: 1 }, body: { message: history[0].content,
      assistantId: 'scoped-assistant', assistantRevision: 'published', requestId: 'qa-valid-001' } } as any, res));
    expect(res.statusCode).toBe(200);
    expect(res.body.data.assistantMessage).toMatchObject({ content: answer, sources });
    expect(res.body.data.response).toMatchObject({ answer, sources });
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({
      executionMode: 'advisory', simulationAssistantId: 'scoped-assistant', simulationRevision: 'published',
    }) }));
    expect(saved.at(-1)).toMatchObject({ role: 'assistant', content: answer, sources });
  });
});
