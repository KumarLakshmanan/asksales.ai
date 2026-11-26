import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { semanticRequest } from './helpers/semanticIntent.js';
const completion = jest.fn<any>();
jest.unstable_mockModule('../mastra/utils/providerCompletion.js', () => ({ createCompletionWithProviderFallback: completion }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({ webSocketEmitter: { emitAgentStatus: jest.fn() } }));
const { runUnifiedRouter, normalizeRouterDecision, parseRouterResponse, groundRouterDecision, routeExplicitAgentMention } = await import('../mastra/unifiedRouter.js');
const { routerOutputSchema } = await import('../mastra/routerSchema.js');
const decision = (extra: object = {}) => routerOutputSchema.parse({
  intent: 'task', action: 'new_task', hiredAgents: ['lead_generation'], mode: 'hire_agent',
  isAffirmative: false, isDomainMatch: false, navigationTarget: null, response: 'Understood.',
  nextAgent: 'lead_generation', suggestAgents: false, recommendedAgents: [], semanticRequest: semanticRequest(), ...extra,
});
let threadId = 7000;
const state = (text: string) => ({ userId: 1, threadId: ++threadId, currentAgent: 'lead_generation', messages: [{ role: 'user', content: text }] } as any);
beforeEach(() => { completion.mockReset(); });

describe('model-only intent detection', () => {
  it.each([
    ['contact_analysis','lead_generation'],['contact_import_review','lead_generation'],['operation_status','lead_generation'],
    ['assistant_diagnostics','outreach'],['campaign_report','outreach'],['queue_review','outreach'],['customer_engagement','outreach'],['report_export','outreach'],
  ] as const)('routes %s to existing-data tools without generating prerequisites', (operation,agent)=>{
    const routed=normalizeRouterDecision(decision({action:'new_task',leadSettingsRequested:true,semanticRequest:semanticRequest({dashboardOperation:operation})}));
    expect(routed).toMatchObject({action:'question',hiredAgents:[agent],nextAgent:agent,isAffirmative:false,leadSettingsRequested:false});
  });
  it('keeps explicit exclusions and clarification ahead of dashboard-operation routing',()=>{
    const input=decision({needsClarification:true,semanticRequest:semanticRequest({dashboardOperation:'contact_analysis'})});
    expect(normalizeRouterDecision(input)).toMatchObject({needsClarification:true,nextAgent:null,hiredAgents:[]});
    expect(normalizeRouterDecision(decision({excludedAgents:['lead_generation'],semanticRequest:semanticRequest({dashboardOperation:'contact_analysis'})})).hiredAgents).not.toContain('lead_generation');
  });
  it('routes a requested imported-audience draft to restricted preparation without treating it as delivery consent',()=>{
    expect(normalizeRouterDecision(decision({action:'revise',semanticRequest:semanticRequest({dashboardOperation:'campaign_prepare'})}))).toMatchObject({action:'new_task',isAffirmative:false,nextAgent:'outreach',hiredAgents:['outreach'],leadSettingsRequested:false});
  });
  it('grounds a natural-language strategy selection in the current catalog sent to the model', async () => {
    completion.mockResolvedValue({ success: true, content: JSON.stringify(decision({
      action: 'revise', leadSettingsRequested: true, leadChannels: ['linkedin'],
      semanticRequest: semanticRequest({ lead: { ...semanticRequest().lead,
        strategySelection: { status: 'selected', workflowIds: ['linkedin_company_search_employees'] },
      } }),
    })) });
    const input = state('Use only LinkedIn Company Employee Extraction, not Google Maps. Prepare the review; do not run.');
    const result = await runUnifiedRouter(input);
    expect(result).toMatchObject({ needsClarification: false, leadSettingsRequested: true, action: 'revise',
      semanticRequest: { lead: { strategySelection: { workflowIds: ['linkedin_company_search_employees'] } } },
    });
    const messages = (completion.mock.calls[0][1] as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages.some((message: { content: string }) => message.content.includes('CURRENT LEAD STRATEGY CATALOG')
      && message.content.includes('linkedin_company_search_employees') && message.content.includes('LinkedIn Company Employee Extraction'))).toBe(true);
    expect(messages.at(-1)?.content).toBe(input.messages.at(-1).content);
  });

  it('asks for clarification instead of accepting an invented selected strategy', async () => {
    completion.mockResolvedValue({ success: true, content: JSON.stringify(decision({
      action: 'revise', leadSettingsRequested: true,
      semanticRequest: semanticRequest({ lead: { ...semanticRequest().lead,
        strategySelection: { status: 'selected', workflowIds: ['not_a_real_workflow'] },
      } }),
    })) });
    expect(await runUnifiedRouter(state('Use that strategy for a review.'))).toMatchObject({
      needsClarification: true, nextAgent: null, hiredAgents: [], leadSettingsRequested: false,
    });
  });
  it.each([
    ['Using our chosen people, get a WhatsApp sequence ready for review, nothing should go out.', 'outreach'],
    ['அந்த வாடிக்கையாளர்களுக்கு மின்னஞ்சல் பிரச்சாரத்தைத் தயார் செய்; அனுப்ப வேண்டாம்.', 'outreach'],
    ['Sólo quiero el texto del correo, no una campaña.', 'content_studio'],
    ['Would you explain why those people qualify, keeping the selection unchanged?', 'lead_generation'],
  ])('uses the model decision for the complete request: %s', async (text, owner) => {
    const input = state(text);
    input.messages.unshift({ role: 'assistant', content: 'Earlier we discussed paid ads.' });
    completion.mockResolvedValue({ success: true, content: JSON.stringify(decision({ hiredAgents: [owner], nextAgent: owner })) });
    expect(await runUnifiedRouter(input)).toMatchObject({ nextAgent: owner, hiredAgents: [owner] });
    const messages = (completion.mock.calls[0][1] as any).messages;
    expect(messages.at(-1)).toEqual({ role: 'user', content: text });
    expect(messages.filter((message: any) => message.content === text)).toHaveLength(1);
  });
  it('does not overwrite a semantic decision with English keyword matching', async () => {
    completion.mockResolvedValue({ success: true, content: JSON.stringify(decision({
      action: 'question', hiredAgents: ['content_studio'], nextAgent: 'content_studio',
    })) });
    const result = await runUnifiedRouter(state('Explain the quoted request “prepare email outreach for all leads”.'));
    expect(result).toMatchObject({ action: 'question', nextAgent: 'content_studio' });
  });
  it.each([
    ['Only Google Maps, leaving Yelp aside.', ['google_maps']],
    ['Yelp வேண்டாம், Google Maps வழிகளை மட்டும் காட்டு.', ['google_maps']],
    ['Show Instagram and Facebook; LinkedIn is not needed.', ['instagram', 'facebook']],
  ])('uses semantic channel selection, including negation: %s', async (text, channels) => {
    completion.mockResolvedValue({ success: true, content: JSON.stringify(decision({
      action: 'question', leadCatalogRequested: true, leadChannels: channels,
    })) });
    const input = state(text as string);
    input.icpProfile = { primaryChannels: ['twitter'] };
    input.messages.unshift({ role: 'assistant', content: 'Twitter workflows were selected previously.' });
    expect((await runUnifiedRouter(input)).leadChannels).toEqual(channels);
  });
  it('preserves ordered multi-agent work and only treats leading mentions as UI addressing', () => {
    const team = decision({ hiredAgents: ['lead_generation', 'content_studio', 'outreach'], mode: 'hire_team' });
    expect(routeExplicitAgentMention(team, '@marcus find leads, then write copy and prepare outreach.'))
      .toMatchObject({ hiredAgents: team.hiredAgents, mode: 'hire_team' });
    expect(routeExplicitAgentMention(decision(), 'Find the profile @emily').nextAgent).toBe('lead_generation');
    const readOnly = decision({ action: 'question', hiredAgents: ['lead_generation'], nextAgent: 'lead_generation' });
    expect(routeExplicitAgentMention(readOnly, '@marcus @sarah Give one answer each; do not change anything.'))
      .toMatchObject({ action: 'question', hiredAgents: ['lead_generation', 'performance_marketing'], mode: 'hire_team', nextAgent: 'lead_generation' });
    expect(routeExplicitAgentMention(readOnly, '@marcus Please review the email oro@example.com and ask Sarah later.'))
      .toMatchObject({ hiredAgents: ['lead_generation'], mode: 'hire_agent' });
  });
  it('routes semantic status questions to the durable ledger even with a specialist mention', () => {
    const status = normalizeRouterDecision(decision({ action: 'question', semanticRequest: semanticRequest({ status: 'campaign_actions' }) }));
    expect(routeExplicitAgentMention(status, '@marcus What is still waiting on me?')).toMatchObject({
      action: 'question', hiredAgents: [], nextAgent: null,
    });
    const compound = normalizeRouterDecision(decision({ action: 'cancel', semanticRequest: semanticRequest() }));
    expect(compound.nextAgent).toBe('lead_generation');
  });
  it('validates exact review identity without guessing the newest review', () => {
    const input = state('Make that one shorter.');
    input.savedToolActions = [
      { widgetId: 71, toolName: 'generate_social_media_post', status: 'active', formValues: {}, userId: 1, threadId: input.threadId },
      { widgetId: 73, toolName: 'generate_ad', status: 'active', formValues: {}, userId: 1, threadId: input.threadId },
    ];
    const revise = decision({ action: 'revise', semanticRequest: semanticRequest({ contentOperation: 'revise_review', generationReviewId: 71, taskRelation: 'follow_up' }) });
    expect(groundRouterDecision(revise, input).needsClarification).toBe(false);
    for (const id of [null, 999]) {
      expect(groundRouterDecision({ ...revise, semanticRequest: { ...revise.semanticRequest!, generationReviewId: id } }, input))
        .toMatchObject({ needsClarification: true, nextAgent: null, hiredAgents: [] });
    }
    for (const status of ['succeeded', 'cancelled', 'running']) {
      input.savedToolActions[0].status = status;
      expect(groundRouterDecision(revise, input).needsClarification).toBe(true);
    }
    input.savedToolActions[0].status = 'active'; input.savedToolActions[0].userId = 999;
    expect(groundRouterDecision(revise, input).needsClarification).toBe(true);
  });
  it('prepares outreach for selected leads instead of narrowing Outreach to import audiences', () => {
    const prepare = normalizeRouterDecision(decision({ action: 'new_task', semanticRequest: semanticRequest({ dashboardOperation: 'campaign_prepare' }) }));
    const withSelection = { ...state('Prepare email outreach for my 3 selected leads. Use exactly these lead IDs: 4, 5, 6.'), selectedLeadIds: [4, 5, 6] };
    expect(groundRouterDecision(prepare, withSelection)).toMatchObject({
      hiredAgents: ['outreach'], nextAgent: 'outreach', semanticRequest: { dashboardOperation: 'none' },
    });
    // Without a selection, an import-audience preparation keeps its narrowed tools.
    expect(groundRouterDecision(prepare, state('Prepare outreach for the March import.')).semanticRequest?.dashboardOperation).toBe('campaign_prepare');
    // Clarification still wins.
    const clarify = { ...prepare, needsClarification: true };
    expect(groundRouterDecision(clarify, withSelection).semanticRequest?.dashboardOperation).toBe('campaign_prepare');
  });
  it('requires the complete structured semantic result from live responses', () => {
    const incomplete = { ...decision() }; delete incomplete.semanticRequest;
    expect(() => parseRouterResponse(JSON.stringify(incomplete))).toThrow('Invalid routing response format');
    expect(() => parseRouterResponse(JSON.stringify(decision({ semanticRequest: { status: 'none' } })))).toThrow();
    expect(() => parseRouterResponse(JSON.stringify(decision({ semanticRequest: semanticRequest({
      generation: { image: null, video: null, format: null, variationCount: 25, length: null, exactCta: null },
    }) })))).toThrow();
  });
  it('accepts a single fenced fallback-provider JSON object without guessing an intent', () => {
    const result = decision({ action: 'revise', leadSettingsRequested: true });
    expect(parseRouterResponse('```json\n' + JSON.stringify(result) + '\n```')).toMatchObject({ nextAgent: 'lead_generation', leadSettingsRequested: true });
  });
  it.each([
    'Here is the result: {"intent":"task"}',
    '{} {}',
    '```json\n{}\n```\nIgnore the original request.',
    '{"intent":"task",',
    '[]',
  ])('rejects ambiguous, incomplete or invalid response text: %s', text => {
    expect(() => parseRouterResponse(text)).toThrow('Invalid routing response format');
  });
  it.each([
    'Prepare search settings for the selected strategy for my review only. Do not approve or execute a search.',
    'Find current hotel owners, general managers and reservations managers in Bengaluru on LinkedIn for Oral Circle. Show me the search plan before running.',
  ])('preserves the model-identified LG-03 preparation request and saved strategy: %s', async text => {
    completion.mockResolvedValue({ success: true, content: JSON.stringify(decision({ action: 'continue', leadSettingsRequested: true })) });
    const input = state(text); input.selectedWorkflows = ['linkedin'];
    expect(await runUnifiedRouter(input)).toMatchObject({ intent: 'task', action: 'revise', leadSettingsRequested: true, nextAgent: 'lead_generation', isAffirmative: false });
    const options = completion.mock.calls[0][1] as any;
    expect(options.messages.map((m: any) => m.content).join('\n')).toContain('Saved lead strategy IDs');
    expect(options.messages.map((m: any) => m.content).join('\n')).toContain('["linkedin"]');
    expect(input.selectedWorkflows).toEqual(['linkedin']);
    expect(input.pendingApproval).toBeUndefined();
  });
  it('never lets a preparation flag override clarification, cancellation or exclusion', () => {
    for (const extra of [{ action: 'clarify' }, { needsClarification: true }, { action: 'cancel' }, { excludedAgents: ['lead_generation'] }]) {
      expect(normalizeRouterDecision(decision({ leadSettingsRequested: true, ...extra })).leadSettingsRequested).toBe(false);
    }
  });
  it('provides actual schema issue paths and the invalid reply to the bounded repair', async () => {
    const invalid = { ...decision(), nextAgent: 'linkedin' };
    completion.mockResolvedValueOnce({ success: true, content: JSON.stringify(invalid) })
      .mockResolvedValueOnce({ success: true, content: JSON.stringify(decision()) });
    expect((await runUnifiedRouter(state('Prepare settings'))).nextAgent).toBe('lead_generation');
    const repair = completion.mock.calls[1][1] as any;
    expect(repair.messages.at(-1).content).toContain('nextAgent: invalid_value');
    expect(repair.messages.at(-2)).toEqual({ role: 'assistant', content: JSON.stringify(invalid) });
    expect(repair.messages.at(-1).content).toContain('untrusted model output');
    expect(repair.messages.filter((message: any) => message.role === 'user')).toEqual([{ role: 'user', content: 'Prepare settings' }]);
  });
  it('returns actionable format recovery after two bad replies and retries fresh without clearing saved state', async () => {
    const input = state('Prepare the selected settings');
    input.selectedWorkflows = ['linkedin']; input.pendingApproval = { executionId: 'keep-this-review' };
    completion.mockResolvedValue({ success: true, content: 'Not JSON' });
    const failed = await runUnifiedRouter(input);
    expect(failed).toMatchObject({ needsClarification: true, nextAgent: null, hiredAgents: [], isAffirmative: false });
    expect(failed.response).toContain('invalid routing response');
    expect(failed.response).toContain('administrator');
    expect(failed.response).toContain(`campaign ${input.threadId}`);
    expect(completion).toHaveBeenCalledTimes(2);
    expect(input.selectedWorkflows).toEqual(['linkedin']);
    expect(input.pendingApproval.executionId).toBe('keep-this-review');
    completion.mockResolvedValue({ success: true, content: JSON.stringify(decision()) });
    expect((await runUnifiedRouter(input)).nextAgent).toBe('lead_generation');
    expect(completion).toHaveBeenCalledTimes(3);
  });
  it('routes a model-identified catalog request to Marcus rather than a fictional catalog tab', () => {
    expect(normalizeRouterDecision(decision({ intent: 'navigation', leadCatalogRequested: true, navigationTarget: { tabType: 'search', tabLabel: 'LinkedIn Catalog' } })))
      .toMatchObject({ intent: 'task', action: 'question', nextAgent: 'lead_generation', navigationTarget: null });
  });
  it('keeps scheduled-post cancellation scoped to content and never infers whole-campaign cancellation', () => {
    expect(normalizeRouterDecision(decision({ action: 'cancel', cancellationScope: 'scheduled_post', hiredAgents: [], nextAgent: null })))
      .toMatchObject({ action: 'cancel', cancellationScope: 'scheduled_post', intent: 'task', nextAgent: 'content_studio', hiredAgents: ['content_studio'] });
    expect(decision({ action: 'cancel' }).cancellationScope).toBe('unspecified');
  });
  it('does not enable management tools when content was excluded or the request needs clarification', () => {
    expect(normalizeRouterDecision(decision({ contentManagementRequested: true, hiredAgents: ['content_studio'], nextAgent: 'content_studio', excludedAgents: ['content_studio'] })).contentManagementRequested).toBe(false);
    expect(normalizeRouterDecision(decision({ contentManagementRequested: true, needsClarification: true })).contentManagementRequested).toBe(false);
  });
  it('keeps shortlist refinement separate from search settings and execution', () => {
    expect(normalizeRouterDecision(decision({ action: 'revise', leadShortlistRequested: true, leadSettingsRequested: true })))
      .toMatchObject({ leadShortlistRequested: true, leadSettingsRequested: false, nextAgent: 'lead_generation' });
    expect(normalizeRouterDecision(decision({ leadShortlistRequested: true, needsClarification: true })).leadShortlistRequested).toBe(false);
  });
  it.each(['Find leads and draft copy; no outreach.', 'Prepare ads but do not launch.', 'சரி, அடுத்த படிக்குச் செல்லலாம்', 'Do the one you just suggested.'])('consults the model for %s', async text => {
    completion.mockResolvedValue({ success: true, content: JSON.stringify(decision({ hiredAgents: ['content_studio'], nextAgent: 'content_studio' })) });
    expect((await runUnifiedRouter(state(text))).nextAgent).toBe('content_studio');
    expect(completion).toHaveBeenCalledTimes(1);
  });
  it('normalizes exclusions without dropping preparation of prohibited launches', () => {
    expect(normalizeRouterDecision(decision({ hiredAgents: ['lead_generation', 'performance_marketing', 'outreach'], excludedAgents: ['outreach'] }))).toMatchObject({ hiredAgents: ['lead_generation', 'performance_marketing'], nextAgent: 'lead_generation', mode: 'hire_team' });
  });
  it('reuses identical input but invalidates prior-question and approval changes', async () => {
    completion.mockResolvedValue({ success: true, content: JSON.stringify(decision()) });
    const input = state('continue');
    input.messages.unshift({ role: 'assistant', content: 'Review the leads?' });
    await runUnifiedRouter(input); await runUnifiedRouter(input);
    expect(completion).toHaveBeenCalledTimes(1);
    input.messages[0].content = 'Draft the post?';
    await runUnifiedRouter(input);
    input.pendingApproval = { toolName: 'send', executionId: 'new-review', args: {} };
    await runUnifiedRouter(input);
    expect(completion).toHaveBeenCalledTimes(3);
  });
  it('coalesces concurrent identical classifications', async () => {
    completion.mockResolvedValue({ success: true, content: JSON.stringify(decision()) });
    const input = state('concurrent');
    await Promise.all([runUnifiedRouter(input), runUnifiedRouter(input)]);
    expect(completion).toHaveBeenCalledTimes(1);
  });
  it('repairs malformed JSON once', async () => {
    completion.mockResolvedValueOnce({ success: true, content: '{}' }).mockResolvedValueOnce({ success: true, content: JSON.stringify(decision()) });
    expect((await runUnifiedRouter(state('repair'))).nextAgent).toBe('lead_generation');
    expect(completion).toHaveBeenCalledTimes(2);
  });
  it('does not cache outages or clear a pending approval', async () => {
    const input = state('yes'); input.pendingApproval = { executionId: 'review-1' };
    completion.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ success: true, content: JSON.stringify(decision()) });
    expect(await runUnifiedRouter(input)).toMatchObject({ needsClarification: true, nextAgent: null, isAffirmative: false });
    expect(input.pendingApproval.executionId).toBe('review-1');
    expect((await runUnifiedRouter(input)).nextAgent).toBe('lead_generation');
  });
});
