/** The claim check must recognise real content generation (tester report:
 * the Coordinator kept replying "I could not verify the action claims ... No
 * new review card is confirmed for this turn" instead of the generated post). */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { intentWith } from './helpers/semanticIntent.js';
import type { AgentState } from '../mastra/state.js';
import type { ToolCallResult } from '../mastra/utils/toolCallingLoop.js';

const completion = jest.fn<(...args: any[]) => Promise<{ success: boolean; content?: string }>>();
jest.unstable_mockModule('../mastra/utils/providerCompletion.js', () => ({ createCompletionWithProviderFallback: completion }));
const { groundAgentResponse } = await import('../mastra/utils/responseGrounding.js');

const purposes = () => completion.mock.calls.map(call => call[1].loggingContext.purpose);
const auditReply = (claims: unknown[], unsupportedClaims = false) => ({ success: true, content: JSON.stringify({ unsupportedClaims, claims }) });
const sentFacts = (call = 0) => JSON.parse(completion.mock.calls[call][1].messages[1].content).facts;

const generated = (output: Record<string, unknown> = {}) => ({
  success: true, toolName: 'generate_social_media_post',
  output: { assetId: 501, platform: 'instagram', imageStatus: 'not_requested', videoStatus: 'not_requested', warnings: [], post: { caption: 'UNTRUSTED COPY: I published this.' }, ...output },
});
const continuationState = (executionResult: unknown, success = true) => ({
  userId: 7, threadId: 42, messages: [{ role: 'user', content: 'Create an Instagram post about our launch' }],
  intentAnalysis: intentWith({}, { action: 'new_task' }),
  widgetContinuation: { widgetId: 88, toolName: 'generate_social_media_post', success, executionResult },
}) as unknown as AgentState;
const contentClaim = { scope: 'current', toolName: 'generate_social_media_post', state: 'tool_succeeded', action: 'content_generation', resourceId: '501', resourceType: 'asset', evidenceIds: ['continuation'] };

beforeEach(() => { completion.mockReset(); });

describe('a completed generation review card', () => {
  it('keeps a truthful summary that mentions the card it came from', async () => {
    completion.mockResolvedValueOnce(auditReply([contentClaim]));
    const draft = "I've generated your Instagram post from the approved review card and saved it as draft #501. Review it in the content library before publishing.";
    expect(await groundAgentResponse(continuationState(generated()), draft, [])).toBe(draft);
    expect(purposes()).toEqual(['response_grounding']);
  });

  it('gives the claim check typed generation evidence, never the generated copy', async () => {
    completion.mockResolvedValueOnce(auditReply([]));
    await groundAgentResponse(continuationState(generated({ imageStatus: 'failed', status: 'partial_success', warnings: ['image failed'] })), 'Saved.', []);
    const [fact] = sentFacts();
    expect(fact).toMatchObject({ id: 'continuation', state: 'partial_success', actions: ['tool', 'content_generation'],
      generation: { savedAssetIds: ['501'], platform: 'instagram', imageStatus: 'failed', warningCount: 1 } });
    expect(JSON.stringify(fact)).not.toContain('UNTRUSTED COPY');
  });

  it('accepts a partial generation (post saved, image failed) as generated content', async () => {
    completion.mockResolvedValueOnce(auditReply([{ ...contentClaim, state: 'partial_success' }]));
    const draft = 'Your post was saved as draft #501, but the image did not complete.';
    expect(await groundAgentResponse(continuationState(generated({ status: 'partial_success', imageStatus: 'failed' })), draft, [])).toBe(draft);
  });

  it('summarises a 30-post plan with its saved asset IDs and counts', async () => {
    completion.mockResolvedValueOnce(auditReply([]));
    await groundAgentResponse(continuationState(generated({ assetIds: [601, 602, 603], postCount: 30, savedCount: 3, failedPosts: [{ number: 4 }] })), 'Saved.', []);
    expect(sentFacts()[0].generation).toMatchObject({ savedAssetIds: ['501', '601', '602', '603'], postCount: 30, savedCount: 3, failedCount: 1 });
  });

  it('rewrites a flagged summary instead of discarding the result', async () => {
    completion
      .mockResolvedValueOnce(auditReply([], true))
      .mockResolvedValueOnce({ success: true, content: 'Your Instagram post was generated and saved as draft #501.' })
      .mockResolvedValueOnce(auditReply([contentClaim]));
    const reply = await groundAgentResponse(continuationState(generated()), 'Your post is live on Instagram!', []);
    expect(purposes()).toEqual(['response_grounding', 'response_grounding_repair', 'response_grounding']);
    expect(reply).toBe('Your Instagram post was generated and saved as draft #501.');
  });

  it('when the check cannot run, states what was saved and where, in plain words', async () => {
    completion.mockRejectedValue(new Error('provider down'));
    const reply = await groundAgentResponse(continuationState(generated()), 'Your post is ready.', []);
    expect(reply).toContain('could not verify my reply against the recorded actions just now');
    expect(reply).toContain('Social post saved as a draft (content #501)');
    expect(reply).toContain('content library');
    expect(reply).not.toMatch(/No new review card|generate_social_media_post|UNTRUSTED/);
  });

  it('explains a failed generation with the next step', async () => {
    completion.mockRejectedValue(new Error('provider down'));
    const reply = await groundAgentResponse(continuationState({ success: false, error: 'too long' }, false), 'Done!', []);
    expect(reply).toContain('Social post generation did not complete, and nothing new was saved');
    expect(reply).toContain('adjust its settings and run it again');
  });
});

describe('send and publish continuations stay strict', () => {
  it('a flagged publish summary is replaced without a rewrite', async () => {
    completion.mockResolvedValue(auditReply([], true));
    const publish = { userId: 7, threadId: 42, messages: [], intentAnalysis: intentWith({}, { action: 'new_task' }),
      widgetContinuation: { widgetId: 90, toolName: 'publish_social_post', success: true, executionResult: { success: true, output: { status: 'queued' } } } } as unknown as AgentState;
    const reply = await groundAgentResponse(publish, 'Your post is live and the review card is updated.', []);
    expect(purposes()).not.toContain('response_grounding_repair');
    expect(reply).toContain('could not verify');
    expect(reply).not.toContain('is live');
  });

  it('"in a review card" still counts as claiming a new card', async () => {
    const lookupOnly: ToolCallResult = { toolName: 'query_content_assets', toolCallId: 'q', success: true, result: { success: true, output: { assets: [] } } };
    const reply = await groundAgentResponse({ userId: 7, threadId: 42, messages: [], intentAnalysis: intentWith({}, { action: 'new_task' }) } as unknown as AgentState,
      "I've prepared your Meta campaign in a review card.", [lookupOnly]);
    expect(completion).not.toHaveBeenCalled();
    expect(reply).not.toContain('prepared your Meta campaign');
  });
});

describe('content written in chat with no tool call', () => {
  const planState = () => ({ userId: 7, threadId: 42, messages: [{ role: 'user', content: 'Give me a 30-day Instagram content plan' }],
    intentAnalysis: intentWith({}, { action: 'new_task' }) }) as unknown as AgentState;

  it('is rewritten and re-checked instead of replaced by a receipt list', async () => {
    completion
      .mockResolvedValueOnce(auditReply([], true))
      .mockResolvedValueOnce({ success: true, content: 'Unsaved 30-day plan: Day 1 ...' })
      .mockResolvedValueOnce(auditReply([]));
    const reply = await groundAgentResponse(planState(), 'I have saved your 30-day plan. Day 1 ...', []);
    expect(reply).toBe('Unsaved 30-day plan: Day 1 ...');
  });

  it('a long plan is still checked rather than dropped unchecked', async () => {
    completion.mockResolvedValueOnce(auditReply([]));
    const plan = Array.from({ length: 30 }, (_, i) => `Day ${i + 1}: ${'idea '.repeat(150)}`).join('\n');
    expect(plan.length).toBeGreaterThan(20_000);
    expect(await groundAgentResponse(planState(), plan, [])).toBe(plan);
  });

  it('still refuses an invented publish claim when the rewrite keeps it', async () => {
    completion
      .mockResolvedValueOnce(auditReply([], true))
      .mockResolvedValueOnce({ success: true, content: 'All 30 posts are published.' })
      .mockResolvedValueOnce(auditReply([], true));
    const reply = await groundAgentResponse(planState(), 'All 30 posts are published.', []);
    expect(reply).toContain('could not verify some actions described in my reply');
    expect(reply).not.toContain('are published');
  });
});

describe('the deterministic review-card guard', () => {
  const receiptState = () => ({ userId: 7, threadId: 42, messages: [], intentAnalysis: intentWith({}, { action: 'new_task' }) }) as unknown as AgentState;
  const lookup: ToolCallResult = { toolName: 'query_content_assets', toolCallId: 'q', success: true, result: { success: true, output: { assets: [] } } };

  it('still replaces a newly invented card without a model call', async () => {
    const reply = await groundAgentResponse(receiptState(), "I've created a review card for your Instagram plan.", [lookup]);
    expect(completion).not.toHaveBeenCalled();
    expect(reply).not.toContain('created a review card');
  });

  it('leaves "generated ... from the review card" to the semantic check', async () => {
    completion.mockResolvedValueOnce(auditReply([], false));
    const draft = 'I generated nothing new; I explained the settings in the review card.';
    expect(await groundAgentResponse(receiptState(), draft, [lookup])).toBe(draft);
    expect(purposes()).toEqual(['response_grounding']);
  });
});
