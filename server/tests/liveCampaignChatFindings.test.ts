/** Regressions for issues found by the live-model campaign chat run
 * (tests/live/campaignChatLive.live.ts). */
import { describe, expect, it, jest } from '@jest/globals';
import { intentWith } from './helpers/semanticIntent.js';
import type { AgentState } from '../mastra/state.js';
import type { ToolCallResult } from '../mastra/utils/toolCallingLoop.js';

const completion = jest.fn<(...args: any[]) => Promise<{ success: boolean; content?: string }>>();
jest.unstable_mockModule('../mastra/utils/providerCompletion.js', () => ({ createCompletionWithProviderFallback: completion }));

const { toUserFacingError, isInternalFailure } = await import('../../shared/userFacingError.js');
const { recommendationFit } = await import('../mastra/agents/leadAgent.js');
const { cancellationTargetsUnstartedReview } = await import('../mastra/orchestrator.js');
const { groundAgentResponse } = await import('../mastra/utils/responseGrounding.js');

describe('internal failures never reach the user verbatim', () => {
  it.each([
    "Cannot read properties of undefined (reading 'id')",
    'provider.createChatCompletion is not a function',
    'duplicate key value violates unique constraint "icp_profiles_pkey"',
    'insert or update on table "icp_profiles" violates foreign key constraint "fk_thread"',
    'relation "icp_profiles" does not exist',
    'connect ECONNREFUSED 127.0.0.1:5432',
  ])('hides %s', message => {
    expect(isInternalFailure(message)).toBe(true);
    expect(toUserFacingError(message)).toBe('This action could not be completed. Please try again.');
    expect(toUserFacingError(new TypeError(message), 'Could not save the ICP.')).toBe('Could not save the ICP.');
  });

  it.each([
    'Select at least one lead before sending.',
    'Your target audience is not defined yet. Describe who you sell to.',
    'The selected Brand Toolkit is inactive.',
  ])('keeps the actionable message %s', message => {
    expect(toUserFacingError(message)).toBe(message);
  });
});

describe('strategy recommendations keep their fit reason', () => {
  it('shows the ranked score and reason', () => {
    expect(recommendationFit({ matchPercentage: 86, reason: 'Chennai hotel hashtags surface hotel accounts.' }))
      .toBe('86% match: Chennai hotel hashtags surface hotel accounts.');
  });
  it('does not present the unranked fallback score as a match', () => {
    expect(recommendationFit({ matchPercentage: 75, reason: 'This is the default fallback recommendation for the channel.', fallback: true }))
      .toBe('Default strategy for this channel; no tailored match was made.');
  });
  it('handles missing fields', () => {
    expect(recommendationFit({})).toBe('Not ranked.');
    expect(recommendationFit({ reason: 'Good local coverage.' })).toBe('Good local coverage.');
  });
});

describe('cancelling while only an unstarted review exists', () => {
  it('targets the review when nothing is running', () => {
    expect(cancellationTargetsUnstartedReview({ pendingApproval: { toolName: 'execute_lead_workflow', args: {}, executionId: 'x', message: '' } })).toBe(true);
    expect(cancellationTargetsUnstartedReview({ pendingApproval: null, savedToolActions: [
      { widgetId: 1, toolName: 'generate_email_template', agentType: 'content_studio', status: 'active', runId: null, formValues: {} }] })).toBe(true);
  });
  it('does not when something is running or nothing is pending', () => {
    expect(cancellationTargetsUnstartedReview({ pendingApproval: { toolName: 't', args: {}, executionId: 'x', message: '' }, savedToolActions: [
      { widgetId: 1, toolName: 'execute_lead_workflow', agentType: 'lead_generation', status: 'running', runId: null, formValues: {} }] })).toBe(false);
    expect(cancellationTargetsUnstartedReview({ pendingApproval: null, savedToolActions: [] })).toBe(false);
  });
});

describe('an empty lookup tells the claim check what was searched', () => {
  const lookup = (output: Record<string, unknown>): ToolCallResult => ({ toolName: 'query_content_assets', toolCallId: 'c1', success: true,
    result: { success: true, output: { assets: [], ...output } } });
  const factsSent = async (output: Record<string, unknown>) => {
    completion.mockResolvedValue({ success: true, content: JSON.stringify({ unsupportedClaims: false, claims: [] }) });
    const state = { userId: 7, threadId: 42, messages: [], intentAnalysis: intentWith({}, { action: 'question' }) } as unknown as AgentState;
    await groundAgentResponse(state, 'This campaign has no saved content yet.', [lookup(output)]);
    return JSON.parse(completion.mock.calls.at(-1)![1].messages[1].content).facts[0];
  };
  it('passes an unfiltered campaign lookup as such', async () => {
    expect(await factsSent({ scope: 'current_campaign', threadId: 42, narrowed: false }))
      .toMatchObject({ returnedRecordCount: 0, lookup: { scope: 'current_campaign', narrowed: false } });
  });
  it('treats an older receipt without the flag as narrowed', async () => {
    expect(await factsSent({ scope: 'current_campaign' })).toMatchObject({ lookup: { scope: 'current_campaign', narrowed: true } });
  });
});

describe('a flagged unsaved plan is rewritten, not replaced by a receipt list', () => {
  const planState = () => ({ userId: 7, threadId: 42, messages: [{ role: 'user', content: 'Plan a Facebook campaign at 500 INR a day' }],
    intentAnalysis: intentWith({}, { action: 'new_task' }) }) as unknown as AgentState;
  const lookup: ToolCallResult = { toolName: 'query_content_assets', toolCallId: 'c1', success: true,
    result: { success: true, output: { scope: 'current_campaign', narrowed: true, assets: [] } } };
  const purposes = () => completion.mock.calls.map(call => call[1].loggingContext.purpose);

  it('rewrites and re-checks when the turn only looked things up', async () => {
    completion.mockReset()
      .mockResolvedValueOnce({ success: true, content: JSON.stringify({ unsupportedClaims: true, claims: [] }) })
      .mockResolvedValueOnce({ success: true, content: 'Unsaved outline: Facebook, Chennai hotel owners, INR 500 a day.' })
      .mockResolvedValueOnce({ success: true, content: JSON.stringify({ unsupportedClaims: false, claims: [] }) });
    const reply = await groundAgentResponse(planState(), 'I found no saved ad creative. Unsaved outline: ...', [lookup]);
    expect(purposes()).toEqual(['response_grounding', 'response_grounding_repair', 'response_grounding']);
    expect(reply).toBe('Unsaved outline: Facebook, Chennai hotel owners, INR 500 a day.');
  });

  it('keeps the receipt fallback when the turn changed something', async () => {
    completion.mockReset().mockResolvedValue({ success: true, content: JSON.stringify({ unsupportedClaims: true, claims: [] }) });
    const write: ToolCallResult = { toolName: 'publish_ads', toolCallId: 'c2', success: true, result: { success: true, output: {} } };
    await groundAgentResponse(planState(), 'Your ads are live.', [lookup, write]);
    expect(purposes()).toEqual(['response_grounding']);
  });

  it('also rewrites when no tool ran at all (content written in chat), and re-checks the rewrite', async () => {
    completion.mockReset().mockResolvedValue({ success: true, content: JSON.stringify({ unsupportedClaims: true, claims: [] }) });
    const reply = await groundAgentResponse(planState(), 'Done.', []);
    expect(purposes()).toEqual(['response_grounding', 'response_grounding_repair', 'response_grounding']);
    expect(reply).toMatch(/Here is what (?:actually happened|the system recorded)/);
  });
});

describe('a specialist is told a pending review already exists', () => {
  it('says so in the agent context', async () => {
    const { buildAgentContext } = await import('../mastra/utils/contextManager.js');
    const context = buildAgentContext({ userId: 7, threadId: 42, messages: [], requiresApproval: true,
      pendingApproval: { toolName: 'execute_lead_workflow', args: {}, executionId: 'lead-input-set:4:2', message: 'Approve to execute?' } } as unknown as AgentState);
    expect(context).toContain('This review already exists from an earlier turn');
    expect(context).toContain('Never say that no review or approval card exists');
  });
});

describe('true denials and harmless control tools in the claim check', () => {
  const planState = () => ({ userId: 7, threadId: 42, messages: [{ role: 'user', content: 'Plan a Facebook campaign' }],
    intentAnalysis: intentWith({}, { action: 'new_task' }) }) as unknown as AgentState;
  const receipt = (toolName: string): ToolCallResult => ({ toolName, toolCallId: toolName, success: true, result: { success: true, output: {} } });

  it('keeps a platform-named denial such as "No Facebook campaign review card was created"', async () => {
    completion.mockReset().mockResolvedValue({ success: true, content: JSON.stringify({ unsupportedClaims: false, claims: [] }) });
    const draft = 'No Facebook campaign review card was created. Unsaved outline: INR 500 a day.';
    expect(await groundAgentResponse(planState(), draft, [receipt('query_content_assets')])).toBe(draft);
  });

  it('still replaces an invented card without asking a model', async () => {
    completion.mockReset();
    const reply = await groundAgentResponse(planState(), 'Your Facebook review card is ready below.', [receipt('query_content_assets')]);
    expect(reply).not.toContain('ready below');
    expect(completion).not.toHaveBeenCalled();
  });

  it('allows the rewrite when the only other receipt is a specialist suggestion', async () => {
    completion.mockReset()
      .mockResolvedValueOnce({ success: true, content: JSON.stringify({ unsupportedClaims: true, claims: [] }) })
      .mockResolvedValueOnce({ success: true, content: 'Unsaved outline. Alex can create the ad creative first.' })
      .mockResolvedValueOnce({ success: true, content: JSON.stringify({ unsupportedClaims: false, claims: [] }) });
    const reply = await groundAgentResponse(planState(), 'draft', [receipt('query_content_assets'), receipt('suggest_switch_agents')]);
    expect(reply).toBe('Unsaved outline. Alex can create the ad creative first.');
  });
});

describe('a filtered empty lookup names what was searched', () => {
  it('passes the filters to the claim check', async () => {
    completion.mockReset().mockResolvedValue({ success: true, content: JSON.stringify({ unsupportedClaims: false, claims: [] }) });
    const state = { userId: 7, threadId: 42, messages: [], intentAnalysis: intentWith({}, { action: 'question' }) } as unknown as AgentState;
    await groundAgentResponse(state, 'There is no saved ad creative for this campaign.', [{ toolName: 'query_content_assets', toolCallId: 'c', success: true,
      result: { success: true, output: { scope: 'current_campaign', narrowed: true, filters: { type: 'ad_copy' }, assets: [] } } }]);
    const fact = JSON.parse(completion.mock.calls.at(-1)![1].messages[1].content).facts[0];
    expect(fact.lookup).toEqual({ scope: 'current_campaign', narrowed: true, filters: { type: 'ad_copy' } });
  });
});

// Regressions from the Nov 18 live campaign chat run on asksales.ai.
describe('schema validation errors never reach the user verbatim', () => {
  it('hides a serialized Zod issue list', () => {
    const zodJson = JSON.stringify([{ expected: 'string', code: 'invalid_type', path: ['subject'], message: 'Invalid input: expected string, received undefined' }], null, 2);
    expect(isInternalFailure(zodJson)).toBe(true);
    expect(toUserFacingError(zodJson, 'Generation did not complete.')).toBe('Generation did not complete.');
  });
});

describe('a channel with one saved workflow is not shown as a 100% match', () => {
  it('says it was not ranked', () => {
    expect(recommendationFit({ matchPercentage: 100, reason: 'This is the only saved workflow currently available for this channel.', onlyOption: true }))
      .toBe('Only saved strategy for this channel; not ranked against your request.');
  });
});

describe('proposal and lead lookups are read-only lookups with visible results', () => {
  const questionState = () => ({ userId: 7, threadId: 42, messages: [{ role: 'user', content: 'Show my proposals and catalog' }],
    intentAnalysis: intentWith({}, { action: 'question' }) }) as unknown as AgentState;
  const receipt = (toolName: string, output: unknown): ToolCallResult => ({ toolName, toolCallId: toolName, success: true, result: { success: true, output } });

  it('sends proposal lookups to the claim check as query facts', async () => {
    completion.mockReset().mockResolvedValue({ success: true, content: JSON.stringify({ unsupportedClaims: false, claims: [] }) });
    await groundAgentResponse(questionState(), 'You have one proposal.', [receipt('list_proposals', { proposals: [], total: 0, scope: 'all' })]);
    const fact = JSON.parse(completion.mock.calls.at(-1)![1].messages[1].content).facts[0];
    expect(fact).toMatchObject({ toolName: 'list_proposals', state: 'query_succeeded', actions: ['query'] });
  });

  it('shows the proposals, services and templates when the reply cannot be checked', async () => {
    completion.mockReset().mockResolvedValue({ success: false });
    const reply = await groundAgentResponse(questionState(), 'draft', [
      receipt('list_proposals', { proposals: [{ id: 12, title: 'AI Ops Retainer', status: 'draft', recipientName: 'Asha', currency: 'INR', total: 150000 }], total: 1, scope: 'all' }),
      receipt('list_proposal_catalog', { items: [{ id: 3, name: 'Automation audit', currency: 'INR', unitPrice: 25000, unit: 'project' }], total: 1 }),
      receipt('list_proposal_templates', [{ id: 5, name: 'SaaS automation', category: 'services' }]),
    ]);
    expect(reply).toContain('"AI Ops Retainer" (status: "draft"); for "Asha"; total INR 150,000');
    expect(reply).toContain('"Automation audit" at INR 25,000 per "project"');
    expect(reply).toContain('"SaaS automation"');
    expect(reply).not.toContain('Here is what actually happened');
  });

  it('shows account-wide lead totals', async () => {
    completion.mockReset().mockResolvedValue({ success: false });
    const reply = await groundAgentResponse(questionState(), 'draft', [
      receipt('query_leads', { scope: 'all', total: 808, withEmail: 412, withPhone: 233, count: 50, leads: [] }),
    ]);
    expect(reply).toContain('Leads across your account: 808; 412 with an email address; 233 with a phone number.');
  });

  it('gives the answer check the lead totals, so a correct count is kept', async () => {
    const draft = 'You have 808 leads across your account; 412 have an email address.';
    completion.mockReset().mockResolvedValueOnce({ success: true, content: JSON.stringify({ unsupportedClaims: false, claims: [
      { scope: 'current', toolName: 'query_leads', state: 'query_succeeded', action: 'query', resourceId: null, resourceType: null, evidenceIds: ['current:0'] },
    ] }) });
    const reply = await groundAgentResponse(questionState(), draft, [
      receipt('query_leads', { scope: 'all', filtered: false, total: 808, withEmail: 412, withPhone: 233, count: 50, leads: [{ fullName: 'SECRET_LEAD' }] }),
    ]);
    expect(reply).toBe(draft);
    const payload = JSON.parse((completion.mock.calls[0] as any)[1].messages[1].content);
    expect(payload.facts[0].leadCounts).toEqual({ scope: 'all', filtered: false, total: 808, withEmail: 412, withPhone: 233 });
    expect(JSON.stringify(payload.facts)).not.toContain('SECRET_LEAD');
  });

  it('says when lead totals only cover a filtered lookup', async () => {
    completion.mockReset().mockResolvedValue({ success: false });
    const reply = await groundAgentResponse(questionState(), 'draft', [
      receipt('query_leads', { scope: 'all', filtered: true, total: 40, withEmail: 40, withPhone: 2, count: 40, leads: [] }),
    ]);
    expect(reply).toContain('Leads matching this lookup across your account: 40');
  });
});

describe('email sequences are planned step by step', () => {
  it('clamps steps and fills follow-up delays', async () => {
    const { emailSequencePlan, emailSequenceStepInstruction } = await import('../mastra/tools/executors/contentExecutor.js');
    expect(emailSequencePlan(undefined, undefined)).toEqual({ steps: 1, delays: [] });
    expect(emailSequencePlan(3, [3, 7])).toEqual({ steps: 3, delays: [3, 7] });
    expect(emailSequencePlan(3, [5])).toEqual({ steps: 3, delays: [5, 3] });
    expect(emailSequencePlan(9, [-1, 'x'])).toEqual({ steps: 5, delays: [3, 3, 3, 3] });
    expect(emailSequenceStepInstruction(1, 3, 0, [])).toContain('write only this first email');
    expect(emailSequenceStepInstruction(3, 3, 7, ['Intro', 'Quick follow-up'])).toContain('sent 7 days after the previous email');
    expect(emailSequenceStepInstruction(3, 3, 7, ['Intro'])).toContain('final email');
  });
});
