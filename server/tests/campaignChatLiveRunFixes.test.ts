/** Regressions for issues found by the live-model campaign chat run (Nov 23). */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const actorHistory = jest.fn<(...args: unknown[]) => Promise<unknown[]>>();
const allAccountHistory = jest.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []);
jest.unstable_mockModule('../models/apifyUsages/functions.js', () => ({ getActorRunHistory: actorHistory, getActorRunHistoryAllAccounts: allAccountHistory }));
const creditsFor = jest.fn(async (cents: number) => Math.round(cents * 10) / 10);
jest.unstable_mockModule('../services/CreditDeductionHooks.js', () => ({ estimateCreditsFromCostCents: creditsFor }));
const completion = jest.fn<(...args: unknown[]) => Promise<{ success: boolean; content?: string }>>();
jest.unstable_mockModule('../mastra/utils/providerCompletion.js', () => ({ createCompletionWithProviderFallback: completion }));
const detectLanguage = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const localize = jest.fn<(...args: unknown[]) => Promise<string | null>>();
jest.unstable_mockModule('../services/agents/orchestration/ReplyLanguage.js', () => ({
  detectMessageLanguage: detectLanguage, localizeGovernedReply: localize,
  looksEnglish: () => true, replyTargetLanguage: () => null,
}));

const { createLeadAgent } = await import('../mastra/agents/leadAgent.js');
const { estimateLeadSearchCost, recommendWorkflowsForChannels } = await import('../mastra/tools/executors/leadExecutor.js');
const { groundAgentResponse } = await import('../mastra/utils/responseGrounding.js');
const { LLMProviderFactory } = await import('../services/agents/LLMProviderFactory.js');
const { sameOutreachReviews, reviewCardSummary } = await import('../mastra/utils/toolCallingLoop.js');
const { MessageService } = await import('../services/agents/MessageService.js');

const reviewedApproval = () => ({
  toolName: 'execute_lead_workflow', executionId: 'lead-input-set:5014:1', message: 'Lead inputs generated. Approve to execute?',
  args: { platforms: ['google_maps'], selected_workflows: ['google_maps_b2b'], leadInputSetId: '5014', leadInputSetRevision: 1, workflowRunId: 'run-1' },
});

describe('typed "run it" while a reviewed search is pending', () => {
  it('keeps the reviewed approval and its button instead of an unbound one', async () => {
    const agent = createLeadAgent() as any;
    const state: any = { userId: 7, threadId: 42, messages: [], leadInputs: [{ platform: 'google_maps', inputs: {} }],
      selectedWorkflows: ['google_maps_b2b'], requiresApproval: true, pendingApproval: reviewedApproval() };
    await agent.preProcess(state);
    agent._handleToolResult('execute_lead_workflow', { success: true, requiresApproval: true, output: { message: 'Ready to search. Approve to proceed?' } }, state, {});
    const returned = agent.buildReturnState(state, {});
    expect(returned.requiresApproval).toBe(true);
    expect(returned.pendingApproval).toEqual(reviewedApproval());
    expect(agent.buildActionButtons(state, [])[0].data).toEqual(expect.objectContaining({ requestId: 'lead-input-set:5014:1', inputSetId: '5014', revision: 1 }));
  });

  it('never creates an approval that the executor would refuse', async () => {
    const agent = createLeadAgent() as any;
    const state: any = { userId: 7, threadId: 42, messages: [], leadInputs: [{ platform: 'google_maps', inputs: {} }], selectedWorkflows: [] };
    await agent.preProcess(state);
    agent._handleToolResult('execute_lead_workflow', { success: true, requiresApproval: true, output: {} }, state, {});
    const returned = agent.buildReturnState(state, {});
    expect(returned.requiresApproval).toBe(false);
    expect(returned.pendingApproval).toBeNull();
    const result = await agent.postProcess(state, { text: 'Ready to search for leads. Approve to proceed?', toolResults: [] });
    expect(result.text).toContain('no reviewed search settings');
    expect(result.text).toContain('No search has run');
  });
});

describe('strategy recommendation uses the requested search, not a different ICP location', () => {
  it('tells the selector that user requirements override the ICP', async () => {
    const createChatCompletion = jest.fn(async () => ({ success: true, content: JSON.stringify({ workflowId: 'instagram_post_authors', matchPercentage: 70, reason: 'Madrid hotels' }) }));
    jest.spyOn(LLMProviderFactory as any, 'createProviderForUser').mockResolvedValue({ defaultModel: 'm', createChatCompletion });
    await recommendWorkflowsForChannels(['instagram'], { primaryRegions: ['Chennai, India'] } as any, 'Find 30 boutique hotels in Madrid', { userId: 7, threadId: 42 });
    const messages = (createChatCompletion.mock.calls[0] as any)[0].messages;
    expect(messages[0].content).toContain('override the ICP');
    expect(messages[0].content).toContain('never on a different ICP location');
    expect(messages[1].content).toContain('USER REQUIREMENTS: Find 30 boutique hotels in Madrid');
  });
});

describe('lead search cost estimate', () => {
  beforeEach(() => { actorHistory.mockReset(); creditsFor.mockClear(); });
  const context = (extra: Record<string, unknown> = {}) => ({ userId: 7, threadId: 42, ...extra }) as any;

  it('estimates from past runs of the same scraper and the reviewed result cap', async () => {
    actorHistory.mockResolvedValue([{ actorId: 'compass/crawler-google-places', runs: 4, items: 200, costCents: 80, avgDurationMs: 150_000, maxDurationMs: 400_000 }]);
    const result: any = await estimateLeadSearchCost({}, context({ leadInputs: [{ platform: 'google_maps', actorId: 'compass/crawler-google-places', actorName: 'Google Maps Scraper',
      inputs: { searchStringsArray: ['boutique hotels in Chennai'], maxCrawledPlacesPerSearch: 50 } }] }));
    expect(actorHistory).toHaveBeenCalledWith(7, ['compass/crawler-google-places']);
    expect(result.output.status).toBe('estimated');
    expect(result.output.requestedResults).toBe(50);
    expect(result.output.estimates[0]).toEqual(expect.objectContaining({ pastRuns: 4, estimatedCredits: 20, typicalMinutes: 3, longestMinutes: 7 }));
    expect(result.output.totalEstimatedCredits).toBe(20);
  });

  it('says plainly when there is no history to estimate from', async () => {
    actorHistory.mockResolvedValue([]);
    const result: any = await estimateLeadSearchCost({ result_count: 50 }, context({ leadInputs: [{ platform: 'google_maps', actorId: 'compass/crawler-google-places', inputs: {} }] }));
    expect(result.output.status).toBe('no_history');
    expect(result.output.totalEstimatedCredits).toBeNull();
    expect(result.output.basis).toContain('charged on the actual Apify usage');
  });

  it('falls back to every account\'s runs of the scraper for a first search, only with enough runs', async () => {
    actorHistory.mockResolvedValue([]);
    const inputs = { leadInputs: [{ platform: 'google_maps', actorId: 'compass/crawler-google-places', inputs: { maxCrawledPlacesPerSearch: 50 } }] };
    allAccountHistory.mockResolvedValueOnce([{ actorId: 'compass/crawler-google-places', runs: 12, items: 1200, costCents: 480, avgDurationMs: 180_000, maxDurationMs: 420_000 }]);
    const shared: any = await estimateLeadSearchCost({}, context(inputs));
    expect(allAccountHistory).toHaveBeenCalledWith(['compass/crawler-google-places']);
    expect(shared.output.status).toBe('estimated');
    expect(shared.output.estimates[0]).toEqual(expect.objectContaining({ source: 'all_accounts', estimatedCredits: 20 }));
    expect(shared.output.basis).toContain("all accounts'");
    allAccountHistory.mockResolvedValueOnce([{ actorId: 'compass/crawler-google-places', runs: 2, items: 100, costCents: 40 }]);
    expect(((await estimateLeadSearchCost({}, context(inputs))) as any).output.status).toBe('no_history');
  });

  it('uses the pending search review when its inputs are not loaded', async () => {
    actorHistory.mockResolvedValue([]);
    const result: any = await estimateLeadSearchCost({}, context({ pendingApproval: { toolName: 'execute_lead_workflow', executionId: 'lead-input-set:4:2',
      args: { platforms: ['google_maps'], selected_workflows: ['google_maps_places'], leadInputSetId: 4, leadInputSetRevision: 2 } } }));
    expect(result.output.status).not.toBe('no_search_settings');
    expect(actorHistory).toHaveBeenCalledWith(7, [expect.any(String)]);
  });

  it('asks for search settings first when none are reviewed', async () => {
    const result: any = await estimateLeadSearchCost({}, context());
    expect(result.output.status).toBe('no_search_settings');
    expect(actorHistory).not.toHaveBeenCalled();
  });
});

describe('recorded-facts fallback keeps the user language', () => {
  beforeEach(() => { completion.mockReset(); detectLanguage.mockReset(); localize.mockReset(); });
  const tamil = 'சென்னை ஹோட்டல்களுக்கு இப்போது மின்னஞ்சல் அனுப்ப முடியுமா?';
  const leadsReceipt = [{ toolName: 'query_leads', toolCallId: 'c1', success: true, result: { output: { total: 0, withEmail: 0, withPhone: 0 } } }] as any;
  const state = (message: string) => ({ userId: 7, threadId: 42, messages: [{ role: 'user', content: message }], intentAnalysis: { action: 'question' } }) as any;

  it('translates the fallback when the audit and repair both fail', async () => {
    completion.mockResolvedValue({ success: false });
    detectLanguage.mockResolvedValue({ code: 'ta', name: 'Tamil', confidence: 0.99 });
    localize.mockResolvedValue('படித்தவை: 0 leads.');
    const reply = await groundAgentResponse(state(tamil), 'Draft', leadsReceipt);
    expect(detectLanguage).toHaveBeenCalledWith(7, tamil);
    expect((localize.mock.calls[0] as any)[0].text).toContain('Here is what I checked:');
    expect(reply).toBe('படித்தவை: 0 leads.');
  });

  it('keeps the English facts when translation is not verified', async () => {
    completion.mockResolvedValue({ success: false });
    detectLanguage.mockResolvedValue({ code: 'ta', name: 'Tamil', confidence: 0.99 });
    localize.mockResolvedValue(null);
    expect(await groundAgentResponse(state(tamil), 'Draft', leadsReceipt)).toContain('Here is what I checked:');
  });

  it('does not translate for an English message', async () => {
    completion.mockResolvedValue({ success: false });
    detectLanguage.mockResolvedValue(null);
    expect(await groundAgentResponse(state('How many leads can we email now?'), 'Draft', leadsReceipt)).toContain('Here is what I checked:');
    expect(localize).not.toHaveBeenCalled();
  });
});

describe('outreach review cards', () => {
  const card = (id: number, formValues: Record<string, unknown>, status = 'active') =>
    ({ id, toolName: 'send_outreach_messages', userId: 7, threadId: 42, status, formValues });

  it('finds the unstarted card for the same channel and recipients only', () => {
    const widgets = [
      card(1, { channel: 'email', lead_ids: [3, 1, 2] }),
      card(2, { channel: 'sms', lead_ids: [1, 2, 3] }),
      card(3, { channel: 'email', lead_ids: [1, 2] }),
      card(4, { channel: 'email', lead_ids: [1, 2, 3] }, 'completed'),
      { ...card(5, { channel: 'email', lead_ids: [1, 2, 3] }), threadId: 99 },
    ];
    expect(sameOutreachReviews(widgets, 'send_outreach_messages', 7, 42, { channel: 'email', lead_ids: [1, 2, 3, 3] }).map(w => w.id)).toEqual([1]);
    expect(sameOutreachReviews(widgets, 'generate_email_template', 7, 42, { channel: 'email', lead_ids: [1, 2, 3] })).toEqual([]);
    expect(sameOutreachReviews(widgets, 'send_outreach_messages', 7, 42, { channel: 'email', lead_ids: [] })).toEqual([]);
  });

  it('says what the card holds and that nothing has been sent', () => {
    const text = reviewCardSummary('send_outreach_messages', { args: { channel: 'email', lead_ids: [1, 2, 2, 5], subject: 'Capture guest enquiries after hours' }, replacedWidgetId: 9 });
    expect(text).toBe('Email outreach to 3 selected leads is ready for review in the card below, with the subject "Capture guest enquiries after hours". It replaces the earlier draft for the same recipients. Check the recipients and message, then select **Confirm and run** to send it. Nothing has been sent yet.');
    expect(reviewCardSummary('send_outreach_messages', { args: { channel: 'whatsapp', lead_ids: [1], scheduled_for: '2026-11-24T04:30:00Z' } }))
      .toContain('WhatsApp outreach to 1 selected lead is ready for review in the card below. Check the recipients and message, then select **Confirm and run** to schedule it for Tue, 24 Nov 2026 04:30:00 UTC.');
    expect(reviewCardSummary('generate_email_template', { args: { variation_count: 3 } })).toBe('The settings for 3 emails are ready for review in the card below. Select **Confirm and run** to generate them. Nothing has been generated yet.');
    expect(reviewCardSummary('unknown_tool')).toBeNull();
  });
});

describe('typed approval of a paid action', () => {
  it('tells the classifier that a bare "ok" does not approve spending, sending or publishing', async () => {
    const createChatCompletion = jest.fn(async () => ({ success: true, content: '{"decision":"modify_or_unclear"}' }));
    jest.spyOn(LLMProviderFactory as any, 'createProviderForUser').mockResolvedValue({ defaultModel: 'm', createChatCompletion });
    const decision = await MessageService.resolvePendingApprovalDecision({
      userId: 7, threadId: 4242, llmConfig: {} as any, message: 'ok', currentAgent: 'lead_generation', pendingApproval: reviewedApproval(),
    });
    expect(decision).toBe('modify_or_unclear');
    const prompt = (createChatCompletion.mock.calls[0] as any)[0].messages[0].content as string;
    expect(prompt).toContain('a bare acknowledgement that does not itself express going ahead ("ok"');
    expect(prompt).toContain('Clear assent to run, send or approve ("yes", "yes run it", "go ahead"');
  });
});
