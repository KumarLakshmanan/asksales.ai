import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { intentWith } from './helpers/semanticIntent.js';
import { z } from 'zod';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const executeProviderCallWithFallback = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createChatMessage = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createWidget = jest.fn<any>();
const replaceReview = jest.fn<any>();
const emitWidgetUpdate = jest.fn<any>();
const updateMessageId = jest.fn<any>();
const findWidgets = jest.fn<any>();
const toolHasWidget = jest.fn<any>();
const getWidgetTypeForTool = jest.fn<any>();
const emitToolExecution = jest.fn<any>();
const emitChatResponse = jest.fn<any>();
const findContentAsset = jest.fn<any>();

class MockProviderResponseError extends Error {
  readonly isProviderResponseError = true;

  constructor(
    message: string,
    readonly provider: string,
    readonly model: string,
  ) {
    super(message);
    this.name = 'LLMProviderResponseError';
  }
}

jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({
  LLMProviderFactory: { executeProviderCallWithFallback },
}));

jest.unstable_mockModule('../services/agents/LLMProviderErrors.js', () => ({
  LLMProviderResponseError: MockProviderResponseError,
}));

jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({
  webSocketEmitter: {
    emitToolExecution,
    emitChatResponse,
    emitWidgetCreated: jest.fn(),
    emitWidgetUpdate,
  },
}));

jest.unstable_mockModule('../models/chatMessages/functions.js', () => ({
  createChatMessage,
}));

jest.unstable_mockModule('../models/widgetStates/functions.js', () => ({
  WidgetStateModel: {
    create: createWidget,
    replacePendingReviewForUser: replaceReview,
    updateMessageId,
    findByThreadForUser: findWidgets,
  },
}));

jest.unstable_mockModule('../models/contentAssets/functions.js', () => ({
  ContentAssetModel: { findByIdForUser: findContentAsset },
}));
jest.unstable_mockModule('../models/companySettings/functions.js', () => ({
  getCompanySettingsByUserId: jest.fn<any>(),
}));
jest.unstable_mockModule('../services/media/VideoReviewPolicy.js', () => ({
  prepareVideoReview: async (values: Record<string, unknown>) => ({ ...values, provider: 'google', model: 'test-model', video_capabilities: {} }),
}));

jest.unstable_mockModule('../shared/toolWidgetMap.js', () => ({
  toolHasWidget,
  getWidgetTypeForTool,
}));

const { runToolCallingLoop } = await import('../mastra/utils/toolCallingLoop.js');
const { adCreativeInputSchema, adPublishInputSchema, unifiedAdPublishInputSchema } = await import('../mastra/tools/adsTools.js');
const { publishSocialPostTool } = await import('../mastra/tools/contentTools.js');
const { queryScheduledPostsTool, editSavedContentTool, changeScheduledPostTool } = await import('../mastra/tools/contentManagementTools.js');

function provider(
  name: string,
  model: string,
  response: Record<string, unknown>,
) {
  return {
    defaultModel: model,
    getProviderName: () => name,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createChatCompletion: jest.fn<any>().mockResolvedValue(response),
  };
}

const baseOptions = {
  userId: 7,
  threadId: 42,
  systemPrompt: 'You are Alex.',
  messages: [{ role: 'user', content: 'Create ad copy' }],
  tools: {},
  toolContext: { userId: 7, threadId: 42 },
  agentType: 'content_studio',
};

describe('sequential content and ad review turns', () => {
  let cards: any[];
  let history: Array<{ role: string; content: string }>;
  const execute = jest.fn<any>();
  beforeEach(() => {
    jest.resetAllMocks();
    cards = [];
    history = [];
    createChatMessage.mockResolvedValue({ id: 1 });
    toolHasWidget.mockReturnValue(true);
    getWidgetTypeForTool.mockReturnValue('ad_generation');
    findWidgets.mockImplementation(async () => cards);
    createWidget.mockImplementation(async (input: Record<string, unknown>) => {
      const card = { ...input, id: cards.length + 1 };
      cards.push(card);
      return card;
    });
    replaceReview.mockImplementation(async (id: number, input: Record<string, unknown>) => {
      const old = cards.find(card => card.id === id);
      if (!old || !['active', 'draft'].includes(old.status)) throw new Error('Review changed');
      const replacement = await createWidget(input);
      old.status = 'cancelled';
      return replacement;
    });
  });

  async function turn(content: string, name: string, args: Record<string, unknown>, context: Record<string, unknown> = {}) {
    history.push({ role: 'user', content });
    const candidate = provider('test', 'test', { success: true, completion: { choices: [{ message: {
      tool_calls: [{ id: `call-${history.length}`, function: { name, arguments: JSON.stringify(args) } }],
    } }] } });
    executeProviderCallWithFallback.mockImplementation((_id: number, callback: (p: typeof candidate) => Promise<unknown>) => callback(candidate));
    const schema = name === 'generate_ad' ? adCreativeInputSchema
      : name === 'publish_ads' ? unifiedAdPublishInputSchema
        : name.startsWith('publish_') ? adPublishInputSchema : z.object({
        platform: z.string(), post_format: z.string().default('image'),
        auto_generate_image: z.boolean().default(true), auto_generate_video: z.boolean().default(true),
        include_image_prompt: z.boolean().default(true), include_video_prompt: z.boolean().default(true),
      });
    const result = await runToolCallingLoop({ ...baseOptions, messages: [...history], maxIterations: 1,
      toolContext: { ...baseOptions.toolContext, ...context },
      tools: { [name]: { inputSchema: schema, execute } } } as never);
    history.push({ role: 'assistant', content: result.text });
    expect(execute).not.toHaveBeenCalled();
    return result;
  }

  const savedActions = (cards: any[]) => cards.map(card => ({ widgetId: card.id,
    toolName: card.toolName, status: card.status, formValues: card.formValues }));

  const generation = (image: boolean, count = 3) => ({ image, video: false,
    format: image ? 'image' as const : 'text' as const, variationCount: count, length: null, exactCta: null });

  it('shows the approved destination in an ad review before generation and preserves an explicit path', async () => {
    const brandContextSnapshot = { businessProfile: { website: 'https://aimplifylabs.com' } };
    await turn('Prepare an ad.', 'generate_ad', { platform: 'meta' }, { brandContextSnapshot });
    expect(cards.at(-1).formValues.landing_url).toBe('https://aimplifylabs.com');
    await turn('Prepare another ad.', 'generate_ad', { platform: 'meta', landing_url: 'https://aimplifylabs.com/demo' }, { brandContextSnapshot });
    expect(cards.at(-1).formValues.landing_url).toBe('https://aimplifylabs.com/demo');
  });

  it('replaces only the exact revised generation card and revokes the old executable review', async () => {
    await turn('Create post.', 'generate_social_media_post', { platform: 'linkedin' });
    await turn('Create a separate ad.', 'generate_ad', { platform: 'meta' });
    const result = await turn('Revise only the post.', 'generate_social_media_post', { platform: 'linkedin' }, {
      savedToolActions: savedActions(cards), intentAnalysis: intentWith({
        taskRelation: 'follow_up', contentOperation: 'revise_review', generationReviewId: 1, generation: generation(false),
      }),
    });
    expect(replaceReview).toHaveBeenCalledWith(1, expect.objectContaining({ userId: 7, threadId: 42, toolName: 'generate_social_media_post' }));
    expect(cards.map(card => card.status)).toEqual(['cancelled', 'active', 'active']);
    expect(emitWidgetUpdate).toHaveBeenCalledWith(7, 42, { id: 1, status: 'cancelled' });
    expect(result.toolResults[0].result).toMatchObject({ pendingWidget: true, output: { widgetId: 3 } });
  });

  it.each(['running', 'succeeded', 'cancelled', 'wrong_thread', 'wrong_owner'])('does not create another card from an unavailable revision (%s)', async condition => {
    await turn('Create post.', 'generate_social_media_post', { platform: 'linkedin' });
    if (condition === 'wrong_thread') cards[0].threadId = 99;
    else if (condition === 'wrong_owner') cards[0].userId = 99;
    else cards[0].status = condition;
    const result = await turn('Revise it.', 'generate_social_media_post', { platform: 'linkedin' }, {
      savedToolActions: savedActions(cards), intentAnalysis: intentWith({ contentOperation: 'revise_review', generationReviewId: 1 }),
    });
    expect(replaceReview).not.toHaveBeenCalled(); expect(cards).toHaveLength(1);
    expect(result.toolResults[0].success).toBe(false);
    expect(emitWidgetUpdate).not.toHaveBeenCalled();
  });

  it('does not announce retirement or create a fallback card after an atomic replacement fails', async () => {
    await turn('Create post.', 'generate_social_media_post', { platform: 'linkedin' });
    replaceReview.mockRejectedValue(new Error('Concurrent submission or database failure'));
    const result = await turn('Revise it.', 'generate_social_media_post', { platform: 'linkedin' }, {
      savedToolActions: savedActions(cards), intentAnalysis: intentWith({ contentOperation: 'revise_review', generationReviewId: 1 }),
    });
    expect(cards).toHaveLength(1); expect(cards[0].status).toBe('active');
    expect(result.toolResults[0].success).toBe(false); expect(emitWidgetUpdate).not.toHaveBeenCalled();
  });

  it.each(['generate_social_media_post', 'generate_ad'])('preserves model-selected %s review defaults across compacted follow-ups', async name => {
    const proposed = { platform: name === 'generate_ad' ? 'meta' : 'linkedin',
      number_of_variations: 1, auto_generate_image: true, auto_generate_video: true };
    await turn('Create text-only copy.', name, proposed, { intentAnalysis: intentWith({ generation: generation(false) }) });
    for (const message of ['Revise it.', 'Make it shorter.', 'Confirm it.']) {
      history = [];
      const id = cards.at(-1).id;
      await turn(message, name, proposed, { savedToolActions: savedActions(cards),
        intentAnalysis: intentWith({ taskRelation: 'follow_up', generationReviewId: id }) });
      expect(cards.at(-1).formValues).toMatchObject({ auto_generate_image: false, auto_generate_video: false });
      if (name === 'generate_ad') expect(cards.at(-1).formValues.number_of_variations).toBe(3);
    }
    await turn('இப்போது ஒரு படம் சேர்க்கவும்', name, proposed, { savedToolActions: savedActions(cards),
      intentAnalysis: intentWith({ taskRelation: 'follow_up', generationReviewId: cards.at(-1).id, generation: generation(true, 2) }) });
    expect(cards.at(-1).formValues).toMatchObject({ auto_generate_image: true, auto_generate_video: false });
    if (name === 'generate_ad') expect(cards.at(-1).formValues.number_of_variations).toBe(2);
  });

  it('refreshes submitted review defaults through the owned read, not original prose', async () => {
    await turn('Create ad copy.', 'generate_ad', { platform: 'meta' }, { intentAnalysis: intentWith({ generation: generation(true) }) });
    cards[0].submittedValues = { ...cards[0].formValues, number_of_variations: 2, ad_format: 'text',
      auto_generate_image: false, auto_generate_video: false };
    cards[0].status = 'draft';
    history = [];
    await turn('Make it shorter.', 'generate_ad', { platform: 'meta', number_of_variations: 1, auto_generate_image: true },
      { savedToolActions: savedActions(cards), intentAnalysis: intentWith({ taskRelation: 'follow_up', generationReviewId: cards[0].id }) });
    expect(cards.at(-1).formValues).toMatchObject({ number_of_variations: 2, ad_format: 'text', auto_generate_image: false });
    expect(findWidgets).toHaveBeenCalledWith(7, 42);
  });

  it('uses resolved semantic constraints even when specialist history is compacted', async () => {
    await turn('Make it shorter.', 'generate_ad', { platform: 'meta', number_of_variations: 1, auto_generate_image: true }, {
      intentAnalysis: intentWith({ taskRelation: 'follow_up', generation: generation(false) }),
      conversationHistory: [{ role: 'system', content: 'Compacted history' }],
    });
    expect(cards.at(-1).formValues).toMatchObject({ number_of_variations: 3, auto_generate_image: false });
  });

  it.each(['generate_social_media_post', 'generate_ad'])('does not leak an earlier %s review into a new task', async name => {
    const args = { platform: name === 'generate_ad' ? 'meta' : 'linkedin', number_of_variations: 1,
      auto_generate_image: true, auto_generate_video: true };
    await turn('Earlier text-only draft.', name, args, { intentAnalysis: intentWith({ generation: generation(false) }) });
    await turn('A fresh task with media.', name, args, { savedToolActions: savedActions(cards),
      intentAnalysis: intentWith({ taskRelation: 'new' }) });
    expect(cards.at(-1).formValues).toMatchObject({ auto_generate_image: true, auto_generate_video: true });
  });

  it('rejects out-of-range model tool arguments rather than clipping to one copy', async () => {
    const result = await turn('Create ad variations.', 'generate_ad', { platform: 'google', number_of_variations: 6 });
    expect(result.toolResults[0].success).toBe(false);
    expect(cards).toHaveLength(0);
  });

  it('keeps exact model-resolved campaign/platform selection but removes fake review fingerprints', async () => {
    const stale = { campaign_id: '18', asset_ids: [88], review_revision: 'a'.repeat(64), platforms: ['google'] };
    for (const message of ['Prepare a campaign review.', 'Revise it.', 'Confirm.']) {
      await turn(message, 'publish_ads', stale, { intentAnalysis: intentWith({
        paidCampaignSelection: { kind: 'single', campaignIds: ['17'], platforms: ['meta'] },
      }) });
      expect(cards.at(-1).formValues).toMatchObject({ campaign_id: '17', platforms: ['meta'] });
      expect(cards.at(-1).formValues).not.toHaveProperty('asset_ids');
      expect(cards.at(-1).formValues).not.toHaveProperty('review_revision');
    }
  });

  it('creates no executable card for ambiguous campaign selection', async () => {
    const result = await turn('Those campaigns.', 'publish_ads', { campaign_id: '19', asset_ids: [88], platforms: ['meta'] }, {
      intentAnalysis: intentWith({ paidCampaignSelection: { kind: 'ambiguous', campaignIds: [], platforms: ['meta'] } }),
    });
    expect(result.toolResults[0].success).toBe(false);
    expect(cards).toHaveLength(0);
  });

  it.each(['publish_meta_ads', 'publish_google_ads'])('does not let %s drop a semantic platform selection', async name => {
    const result = await turn('Both platforms.', name, { campaign_id: '18' }, { intentAnalysis: intentWith({
      paidCampaignSelection: { kind: 'single', campaignIds: ['17'], platforms: ['meta', 'google'] },
    }) });
    expect(result.toolResults[0].success).toBe(false);
    expect(result.toolResults[0].error).toContain('exact requested platforms');
    expect(cards).toHaveLength(0);
  });

});

describe('tool-calling loop provider failure handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createChatMessage.mockResolvedValue({ id: 1 });
    toolHasWidget.mockReturnValue(false);
    getWidgetTypeForTool.mockReturnValue(undefined);
    findWidgets.mockResolvedValue([]);
    findContentAsset.mockResolvedValue({ id: 17, userId: 7 });
  });

  it('sends numeric exclusive bounds for real Content Studio tools and preserves optional inputs', async () => {
    const candidate = provider('openrouter', 'test', {
      success: true, completion: { choices: [{ message: { content: 'Ready to prepare content.' } }] },
    });
    executeProviderCallWithFallback.mockImplementation((_id: number, callback: (p: typeof candidate) => Promise<unknown>) => callback(candidate));
    await runToolCallingLoop({ ...baseOptions, tools: {
      publish_social_post: publishSocialPostTool,
      query_scheduled_posts: queryScheduledPostsTool,
      edit_saved_content: editSavedContentTool,
      change_scheduled_post: changeScheduledPostTool,
      bounded_value: { inputSchema: z.object({ value: z.number().gt(0).lt(10).optional() }) },
    } } as never);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { tools } = candidate.createChatCompletion.mock.calls[0][0] as { tools: Array<{ function: { name: string; parameters: any } }> };
    const checkBounds = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (key === 'exclusiveMinimum' || key === 'exclusiveMaximum') expect(typeof child).toBe('number');
        checkBounds(child);
      }
    };
    checkBounds(tools);
    const publish = tools.find(tool => tool.function.name === 'publish_social_post')!.function.parameters;
    expect(publish.properties.targets.items.properties.credentialId.exclusiveMinimum).toBe(0);
    expect(publish.required).toEqual(['content_asset_id']);
    expect(publish.properties.credential_id.type).toBe('integer');
    const bounded = tools.find(tool => tool.function.name === 'bounded_value')!.function.parameters;
    expect(bounded.properties.value).toEqual({ type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 10 });
    expect(createWidget).not.toHaveBeenCalled();
  });

  it('repairs a historical-receipt echo once before any tool execution', async () => {
    const candidate = provider('gemini', 'test', { success: true, completion: { choices: [{ message: { content: 'No new review exists.' } }] } });
    candidate.createChatCompletion.mockResolvedValueOnce({ success: true, completion: { choices: [{ message: { content: '[Historical server tool receipt — not new authorization] {"widgetId":99}' } }] } });
    executeProviderCallWithFallback.mockImplementation((_id: number, callback: (p: typeof candidate) => Promise<unknown>) => callback(candidate));
    const result = await runToolCallingLoop(baseOptions as never);
    expect(candidate.createChatCompletion).toHaveBeenCalledTimes(2);
    expect(result.text).toBe('No new review exists.');
    expect(createWidget).not.toHaveBeenCalled();
    const correction = candidate.createChatCompletion.mock.calls[1][0] as { messages: Array<{ content: string }> };
    expect(correction.messages.at(-1)?.content).toContain('No tools from that completion were executed');
  });

  it.each([
    'Your review card is ready below.',
    'I have prepared and saved the final campaign draft for review.',
  ])('repairs one unsupported review claim by requiring the real widget tool: %s', async unsupportedClaim => {
    toolHasWidget.mockReturnValue(true);
    getWidgetTypeForTool.mockReturnValue('publish_post');
    createWidget.mockResolvedValue({ id: 42, messageId: null });
    const candidate = provider('openrouter', 'test', {
      success: true,
      completion: { choices: [{ message: { content: unsupportedClaim } }] },
    });
    candidate.createChatCompletion.mockResolvedValueOnce({
      success: true,
      completion: { choices: [{ message: { content: unsupportedClaim } }] },
    }).mockResolvedValueOnce({
      success: true,
      completion: { choices: [{ message: { content: null, tool_calls: [{
        id: 'publish-review',
        function: { name: 'publish_review', arguments: JSON.stringify({ assetId: 17 }) },
      }] } }] },
    });
    executeProviderCallWithFallback.mockImplementation((_id: number, callback: (p: typeof candidate) => Promise<unknown>) => callback(candidate));

    const result = await runToolCallingLoop({ ...baseOptions, tools: {
      publish_review: { inputSchema: z.object({ assetId: z.number() }), execute: jest.fn() },
    } } as never);

    expect(candidate.createChatCompletion).toHaveBeenCalledTimes(2);
    const correction = candidate.createChatCompletion.mock.calls[1][0] as { messages: Array<{ content: string }> };
    expect(correction.messages.at(-3)?.content).toBe(unsupportedClaim);
    expect(correction.messages.at(-2)?.content).toContain('no review-creation tool receipt exists');
    expect(createWidget).toHaveBeenCalledTimes(1);
    expect(result.text).toContain('settings are ready for review');
  });

  it('bounds unsupported review-card repair to one retry', async () => {
    const candidate = provider('openrouter', 'test', {
      success: true,
      completion: { choices: [{ message: { content: 'Your review card is ready below.' } }] },
    });
    executeProviderCallWithFallback.mockImplementation((_id: number, callback: (p: typeof candidate) => Promise<unknown>) => callback(candidate));

    const result = await runToolCallingLoop(baseOptions as never);

    expect(candidate.createChatCompletion).toHaveBeenCalledTimes(2);
    expect(result.text).toBe('Your review card is ready below.');
    expect(createWidget).not.toHaveBeenCalled();
  });

  it('continues an explicit publication review from asset lookup to the real widget tool', async () => {
    toolHasWidget.mockImplementation((toolName: string) => toolName === 'publish_social_post');
    getWidgetTypeForTool.mockReturnValue('publish_post');
    createWidget.mockResolvedValue({ id: 43, messageId: null });
    const queryAssets = jest.fn<any>().mockResolvedValue({ success: true, output: { assets: [{ id: 17 }] } });
    const candidate = provider('openrouter', 'test', {});
    candidate.createChatCompletion
      .mockResolvedValueOnce({ success: true, completion: { choices: [{ message: {
        content: null,
        tool_calls: [{ id: 'lookup-post', function: {
          name: 'query_content_assets',
          arguments: JSON.stringify({ assetIds: [1], filters: { type: 'social_post', channel: 'instagram' } }),
        } }],
      } }] } })
      .mockResolvedValueOnce({ success: true, completion: { choices: [{ message: {
        content: 'I found the latest saved Instagram post and prepared the publication details.',
      } }] } })
      .mockResolvedValueOnce({ success: true, completion: { choices: [{ message: {
        content: null,
        tool_calls: [{ id: 'review-post', function: {
          name: 'publish_social_post',
          arguments: JSON.stringify({ content_asset_id: 17, platform: 'instagram' }),
        } }],
      } }] } });
    executeProviderCallWithFallback.mockImplementation((_id: number, callback: (p: typeof candidate) => Promise<unknown>) => callback(candidate));

    const result = await runToolCallingLoop({
      ...baseOptions,
      messages: [{ role: 'user', content: 'Open a publication review card for the latest Instagram post.' }],
      tools: {
        query_content_assets: {
          description: 'Find assets',
          execute: queryAssets,
        },
        publish_social_post: {
          description: 'Review a post',
          execute: jest.fn(),
        },
      },
    } as never);

    expect(candidate.createChatCompletion).toHaveBeenCalledTimes(3);
    expect(queryAssets).toHaveBeenCalledWith(
      { filters: { type: 'social_post', channel: 'instagram' } },
      expect.any(Object),
    );
    const correction = candidate.createChatCompletion.mock.calls[2][0] as { messages: Array<{ content: string }> };
    expect(correction.messages.at(-2)?.content).toContain('publication review');
    expect(correction.messages.at(-2)?.content).toContain('publish_social_post');
    expect(candidate.createChatCompletion.mock.calls[2][0]).toEqual(expect.objectContaining({
      tool_choice: { type: 'function', function: { name: 'publish_social_post' } },
    }));
    expect(createWidget).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'publish_social_post' }));
    expect(result.text).toContain('settings are ready for review');
  });

  it('fails closed after one unsuccessful echo correction, without an unbounded retry', async () => {
    const candidate = provider('gemini', 'test', { success: true, completion: { choices: [{ message: { content: '[Historical server tool receipt — not new authorization] {"widgetId":99}' } }] } });
    executeProviderCallWithFallback.mockImplementation((_id: number, callback: (p: typeof candidate) => Promise<unknown>) => callback(candidate));
    await expect(runToolCallingLoop(baseOptions as never)).rejects.toThrow('echoed a historical tool receipt');
    expect(candidate.createChatCompletion).toHaveBeenCalledTimes(2);
    expect(createWidget).not.toHaveBeenCalled();
  });

  it.each(['generate_ad', 'publish_ads'])('keeps failed attempt IDs without denying a subsequently created %s review', async (toolName) => {
    toolHasWidget.mockReturnValue(true);
    getWidgetTypeForTool.mockReturnValue('ad_generation');
    createWidget.mockResolvedValue({ id: 42, messageId: null });
    const completion = (id: string, args: object) => ({ success: true, completion: {
      choices: [{ message: { content: null, tool_calls: [{ id, function: {
        name: toolName, arguments: JSON.stringify(args),
      } }] } }],
    } });
    const candidate = provider('openai', 'test', completion('invalid-attempt', {}));
    candidate.createChatCompletion.mockResolvedValueOnce(completion('invalid-attempt', {}))
      .mockResolvedValueOnce(completion('review-attempt', { platform: 'meta' }));
    executeProviderCallWithFallback.mockImplementation((_id: number, callback: (value: typeof candidate) => Promise<unknown>) => callback(candidate));
    const execute = jest.fn();
    const result = await runToolCallingLoop({ ...baseOptions, tools: {
      [toolName]: { inputSchema: z.object({ platform: z.string() }), execute },
    } } as never);
    expect(createWidget).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(result.text).toContain('Earlier attempts failed');
    expect(result.text).not.toContain('did not create a review card');
    if (toolName === 'publish_ads') {
      expect(result.text).toContain('Prepare saved campaign review');
      expect(result.text).toContain('No ads have been published or activated');
    }
    expect(result.toolResults.map(item => item.toolCallId)).toEqual(['invalid-attempt', 'review-attempt']);
    expect(emitToolExecution).toHaveBeenCalledWith(7, 42, expect.objectContaining({ toolCallId: 'invalid-attempt', status: 'failed' }));
    expect(createChatMessage).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ toolCallId: 'invalid-attempt', success: false }) }));
  });

  it('falls back without turning a provider 400 into assistant text', async () => {
    const rejected = provider('gemini', 'gemini-test', {
      success: false,
      error: '400 Provider returned error',
    });
    const working = provider('openai', 'gpt-test', {
      success: true,
      completion: {
        choices: [{ message: { content: 'Here is a polished ad concept.' } }],
      },
    });

    executeProviderCallWithFallback.mockImplementation(async (
      _userId: number,
      callback: (candidate: ReturnType<typeof provider>) => Promise<unknown>,
    ) => {
      await expect(callback(rejected)).rejects.toBeInstanceOf(MockProviderResponseError);
      return callback(working);
    });

    const result = await runToolCallingLoop(baseOptions as never);

    expect(result.text).toBe('Here is a polished ad concept.');
    expect(result.text).not.toContain('Provider returned error');
    expect(rejected.createChatCompletion).toHaveBeenCalledTimes(1);
    expect(working.createChatCompletion).toHaveBeenCalledTimes(1);
    const sent = working.createChatCompletion.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };
    expect(sent.messages.at(-1)).toMatchObject({ role: 'system' });
    expect(sent.messages.at(-1)?.content).toContain('No new interactive review card has been created in this turn');
    expect(sent.messages.at(-1)?.content).toContain('Historical assistant prose is not proof');
  });

  it('throws an upstream failure instead of returning it as a chat response', async () => {
    const rejected = provider('gemini', 'gemini-test', {
      success: false,
      error: '400 Provider returned error',
    });
    executeProviderCallWithFallback.mockImplementation((
      _userId: number,
      callback: (candidate: ReturnType<typeof provider>) => Promise<unknown>,
    ) => callback(rejected));

    await expect(runToolCallingLoop(baseOptions as never)).rejects.toThrow('400 Provider returned error');
  });

  it.each([
    { name: 'analytics_query', action: 'question', needsClarification: false, runs: true },
    { name: 'analytics_query', action: 'new_task', needsClarification: false, runs: false },
    { name: 'analytics_query', action: 'question', needsClarification: true, runs: false },
    { name: 'generate_ad', action: 'question', needsClarification: false, runs: false },
  ])('executes only unambiguous analytics answers without a review: $name/$action/$needsClarification', async ({ name, action, needsClarification, runs }) => {
    createChatMessage.mockResolvedValue({});
    toolHasWidget.mockReturnValue(true);
    getWidgetTypeForTool.mockReturnValue(name === 'analytics_query' ? 'analytics' : 'ad_generation');
    createWidget.mockResolvedValue({ id: 78, toolName: name, status: 'active', formValues: {} });
    const candidate = provider('openrouter', 'test', {
      success: true, completion: { choices: [{ message: { tool_calls: [{ id: 'read-analytics',
        function: { name, arguments: JSON.stringify({ question: 'Show saved campaign results', query_type: 'campaign', scope: 'all_owned' }) },
      }] } }] },
    });
    executeProviderCallWithFallback.mockImplementation((_id: number, callback: (p: typeof candidate) => Promise<unknown>) => callback(candidate));
    const execute = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ success: true, toolName: name,
      output: { summary: 'No saved campaigns linked to this conversation.', data: [] } });

    await runToolCallingLoop({ ...baseOptions, maxIterations: 1,
      toolContext: { ...baseOptions.toolContext,
        intentAnalysis: intentWith({ scope: 'current_campaign' }, { action, needsClarification }),
      }, tools: { [name]: { execute } },
    } as never);

    if (runs) {
      const sent = candidate.createChatCompletion.mock.calls[0][0] as { messages: Array<{ content: string }> };
      expect(sent.messages.at(-1)?.content).toContain('A prohibition on creating reviews does not prohibit this lookup');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({ scope: 'current_campaign' }), expect.anything());
      expect(createWidget).not.toHaveBeenCalled();
    } else {
      expect(execute).not.toHaveBeenCalled();
      expect(createWidget).toHaveBeenCalledTimes(1);
    }
  });

  it.each([true, false])('rechecks a text-only analytics answer once without forcing tools: lookup=$lookup', async (lookup) => {
    const candidate = provider('gemini', 'test', { success: true, completion: { choices: [{ message: { content: 'CTR means click-through rate.' } }] } });
    candidate.createChatCompletion.mockResolvedValueOnce({ success: true, completion: { choices: [{ message: { content: 'I checked the saved data.' } }] } });
    if (lookup) candidate.createChatCompletion.mockResolvedValueOnce({ success: true, completion: { choices: [{ message: { tool_calls: [{
      id: 'fresh-read', function: { name: 'analytics_query', arguments: '{"query_type":"campaign","question":"Show saved results"}' },
    }] } }] } });
    executeProviderCallWithFallback.mockImplementation((_id: number, callback: (p: typeof candidate) => Promise<unknown>) => callback(candidate));
    const execute = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ success: true, output: { data: [] } });
    await runToolCallingLoop({ ...baseOptions, maxIterations: 3,
      toolContext: { ...baseOptions.toolContext, intentAnalysis: intentWith({}, { action: 'question' }) },
      tools: { analytics_query: { execute } },
    } as never);
    expect(candidate.createChatCompletion).toHaveBeenCalledTimes(lookup ? 3 : 2);
    expect(execute).toHaveBeenCalledTimes(lookup ? 1 : 0);
    const correction = candidate.createChatCompletion.mock.calls[1][0] as { messages: Array<{ content: string }>; tool_choice: string };
    expect(correction.messages.some(message => message.content.includes('READ-ONLY EVIDENCE CHECK'))).toBe(true);
    expect(correction.tool_choice).toBe('auto');
    expect(createWidget).not.toHaveBeenCalled();
  });

  it('keeps the first answer to a pure advice question instead of discarding and repeating it', async () => {
    const candidate = provider('gemini', 'test', { success: true, completion: { choices: [{ message: { content: 'CTR means click-through rate.' } }] } });
    executeProviderCallWithFallback.mockImplementation((_id: number, callback: (p: typeof candidate) => Promise<unknown>) => callback(candidate));
    const execute = jest.fn<(...args: unknown[]) => Promise<unknown>>();
    const result = await runToolCallingLoop({ ...baseOptions, maxIterations: 3,
      toolContext: { ...baseOptions.toolContext, intentAnalysis: intentWith({}, { action: 'question', savedDataLookup: false }) },
      tools: { analytics_query: { execute } },
    } as never);
    expect(candidate.createChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('CTR means click-through rate.');
    expect(execute).not.toHaveBeenCalled();
  });

  it('stops after creating an ad review widget and does not claim generation completed', async () => {
    createChatMessage
      .mockResolvedValueOnce({ id: 1 })
      .mockResolvedValueOnce({});
    toolHasWidget.mockImplementation((toolName: string) => toolName === 'generate_ad');
    getWidgetTypeForTool.mockReturnValue('ad_generation');
    createWidget.mockResolvedValue({
      id: 42,
      threadId: 42,
      messageId: null,
      toolName: 'generate_ad',
      widgetType: 'ad_generation',
      formValues: { platform: 'meta', objective: 'sales' },
      status: 'active',
      agentType: 'content_studio',
    });

    const toolCallingProvider = provider('openai', 'gpt-test', {
      success: true,
      completion: {
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'call-1',
              function: {
                name: 'generate_ad',
                arguments: JSON.stringify({ platform: 'meta', objective: 'sales' }),
              },
            }],
          },
        }],
      },
    });
    executeProviderCallWithFallback.mockImplementation((
      _userId: number,
      callback: (candidate: ReturnType<typeof provider>) => Promise<unknown>,
    ) => callback(toolCallingProvider));
    const execute = jest.fn();

    const result = await runToolCallingLoop({
      ...baseOptions,
      tools: {
        generate_ad: {
          description: 'Generate an ad',
          execute,
        },
      },
    } as never);

    expect(toolCallingProvider.createChatCompletion).toHaveBeenCalledTimes(1);
    expect(createWidget).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'generate_ad',
      widgetType: 'ad_generation',
      status: 'active',
    }));
    expect(execute).not.toHaveBeenCalled();
    expect(result.text).toContain('No ad creative has been generated yet.');
    expect(result.text).toContain('Confirm and run');
  });

  it('reuses an identical pending ad widget instead of creating a duplicate', async () => {
    createChatMessage
      .mockResolvedValueOnce({ id: 1 })
      .mockResolvedValueOnce({});
    toolHasWidget.mockImplementation((toolName: string) => toolName === 'generate_ad');
    getWidgetTypeForTool.mockReturnValue('ad_generation');
    findWidgets.mockResolvedValue([{
      id: 41,
      threadId: 42,
      messageId: 9,
      toolName: 'generate_ad',
      widgetType: 'ad_generation',
      formValues: { platform: 'meta', objective: 'sales' },
      status: 'active',
      agentType: 'content_studio',
    }]);
    const toolCallingProvider = provider('openai', 'gpt-test', {
      success: true,
      completion: {
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'call-2',
              function: {
                name: 'generate_ad',
                arguments: JSON.stringify({ platform: 'meta', objective: 'sales' }),
              },
            }],
          },
        }],
      },
    });
    executeProviderCallWithFallback.mockImplementation((
      _userId: number,
      callback: (candidate: ReturnType<typeof provider>) => Promise<unknown>,
    ) => callback(toolCallingProvider));

    const result = await runToolCallingLoop({
      ...baseOptions,
      tools: { generate_ad: { description: 'Generate an ad', execute: jest.fn() } },
    } as never);

    expect(createWidget).not.toHaveBeenCalled();
    expect(result.toolResults[0].result.output).toEqual(expect.objectContaining({
      widgetId: 41,
      reusedWidget: true,
      awaitingSubmission: true,
    }));
    expect(result.text).toContain('No ad creative has been generated yet.');
  });

  it('generates inputs after durable strategy confirmation without adding another configuration widget', async () => {
    toolHasWidget.mockImplementation((toolName: string) => toolName === 'generate_lead_inputs');
    getWidgetTypeForTool.mockReturnValue('lead_generation');
    const leadProvider = provider('openai', 'gpt-test', {});
    leadProvider.createChatCompletion
      .mockResolvedValueOnce({
        success: true,
        completion: { choices: [{ message: {
          content: null,
          tool_calls: [{
            id: 'generate-approved-strategy',
            function: { name: 'generate_lead_inputs', arguments: '{"selected_workflows":["linkedin"]}' },
          }],
        } }] },
      })
      .mockResolvedValueOnce({
        success: true,
        completion: { choices: [{ message: { content: 'Review the saved inputs before starting the search.' } }] },
      });
    executeProviderCallWithFallback.mockImplementation((
      _userId: number,
      callback: (candidate: ReturnType<typeof provider>) => Promise<unknown>,
    ) => callback(leadProvider));
    const execute = jest.fn<any>().mockResolvedValue({
      success: true,
      toolName: 'generate_lead_inputs',
      output: { inputIds: [123], leadInputSetId: 'review-1', leadInputSetRevision: 1, workflowRunId: 'run-1' },
    });
    const search = jest.fn();

    const result = await runToolCallingLoop({
      ...baseOptions,
      agentType: 'lead_generation',
      toolContext: { ...baseOptions.toolContext, runContext: { runId: 'run-1', threadId: 42, userId: 7 } },
      tools: {
        generate_lead_inputs: { description: 'Generate inputs', execute },
        execute_lead_workflow: { description: 'Search leads', execute: search },
      },
    } as never);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({ selected_workflows: ['linkedin'] }, expect.objectContaining({
      mastra: { __toolContext: expect.objectContaining({ runContext: expect.objectContaining({ runId: 'run-1' }) }) },
    }));
    expect(createWidget).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(result.text).toContain('Review the saved inputs');
    expect(result.toolResults[0].result.output.leadInputSetId).toBe('review-1');
  });

  it('stops at an approval boundary instead of invoking the gated tool repeatedly', async () => {
    const approvalProvider = provider('openai', 'gpt-test', {
      success: true,
      completion: {
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'call-approval',
              function: { name: 'execute_lead_workflow', arguments: '{}' },
            }],
          },
        }],
      },
    });
    executeProviderCallWithFallback.mockImplementation((
      _userId: number,
      callback: (candidate: ReturnType<typeof provider>) => Promise<unknown>,
    ) => callback(approvalProvider));
    const execute = jest.fn<any>().mockResolvedValue({
      success: true,
      requiresApproval: true,
      output: { message: 'Approve this exact lead workflow to continue.' },
    });

    const result = await runToolCallingLoop({
      ...baseOptions,
      tools: { execute_lead_workflow: { description: 'Run leads', execute } },
    } as never);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(approvalProvider.createChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('Approve this exact lead workflow to continue.');
    expect(result.toolResults).toHaveLength(1);
  });

  it('terminates a guard rejection as one truthful gated result', async () => {
    const guardedProvider = provider('openai', 'gpt-test', {
      success: true,
      completion: {
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'call-guarded',
              function: { name: 'tasks_completed', arguments: '{}' },
            }, {
              id: 'call-after-guard',
              function: { name: 'send_outreach_messages', arguments: '{}' },
            }],
          },
        }],
      },
    });
    executeProviderCallWithFallback.mockImplementation((
      _userId: number,
      callback: (candidate: ReturnType<typeof provider>) => Promise<unknown>,
    ) => callback(guardedProvider));
    const execute = jest.fn();
    const executeAfterGuard = jest.fn();

    const result = await runToolCallingLoop({
      ...baseOptions,
      tools: {
        tasks_completed: { description: 'Complete the current task', execute },
        send_outreach_messages: { description: 'Send outreach', execute: executeAfterGuard },
      },
      onToolCall: () => false,
    } as never);

    expect(guardedProvider.createChatCompletion).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(executeAfterGuard).not.toHaveBeenCalled();
    expect(result.outcome).toBe('gated');
    expect(result.text).toContain('No action was taken.');
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]).toEqual(expect.objectContaining({
      toolName: 'tasks_completed',
      success: false,
    }));
    expect(result.toolResults[0].result).toEqual(expect.objectContaining({ gated: true }));
    expect(createChatMessage).toHaveBeenCalledTimes(1);
    expect(emitToolExecution).toHaveBeenCalledTimes(1);
    expect(emitToolExecution).toHaveBeenLastCalledWith(7, 42, expect.objectContaining({
      toolName: 'tasks_completed',
      status: 'gated',
    }));
    expect(emitChatResponse).not.toHaveBeenCalled();
  });
});


describe('tool execution authorization and recovery boundaries', () => {
  beforeEach(() => { jest.resetAllMocks(); createChatMessage.mockResolvedValue({ id: 1 }); toolHasWidget.mockReturnValue(false); });
  function calls(items: Array<{ name: string; args?: string }>) {
    const candidate = provider('test', 'test', { success: true, completion: { choices: [{ message: { tool_calls:
      items.map((item, index) => ({ id: `call-${index}`, function: { name: item.name, arguments: item.args ?? '{}' } })) } }] } });
    executeProviderCallWithFallback.mockImplementation((_id: number, callback: (p: typeof candidate) => Promise<unknown>) => callback(candidate));
  }
  it.each(['{', 'null', '[]', '42'])('never executes malformed/non-object arguments: %s', async args => {
    calls([{ name: 'mutation', args }]); const execute = jest.fn(); const guard = jest.fn<() => boolean>(() => true);
    const result = await runToolCallingLoop({ ...baseOptions, maxIterations: 1, tools: { mutation: { execute } }, onToolCall: guard });
    expect(execute).not.toHaveBeenCalled(); expect(guard).not.toHaveBeenCalled();
    expect(result.toolResults[0].result.code).toBe('invalid_arguments');
  });
  it('validates schema before policy and denies thrown policies', async () => {
    calls([{ name: 'mutation', args: '{"count":1}' }]); const execute = jest.fn();
    const guard = jest.fn(() => { throw new Error('policy unavailable'); });
    const result = await runToolCallingLoop({ ...baseOptions, tools: { mutation: { inputSchema: z.object({ count: z.number() }), execute } }, onToolCall: guard });
    expect(execute).not.toHaveBeenCalled(); expect(result.outcome).toBe('gated');
    expect(result.toolResults[0].result.code).toBe('policy_error');
    expect(emitToolExecution.mock.calls.some(call => (call[2] as { status: string }).status === 'started')).toBe(false);
  });
  it('does not execute when the initial durable receipt cannot be saved', async () => {
    calls([{ name: 'mutation' }]); const execute = jest.fn(); createChatMessage.mockRejectedValue(new Error('database unavailable'));
    await expect(runToolCallingLoop({ ...baseOptions, tools: { mutation: { execute } } })).rejects.toThrow('database unavailable');
    expect(execute).not.toHaveBeenCalled();
  });
  it('retains the real result and stops later mutations when result application fails', async () => {
    calls([{ name: 'mutation' }, { name: 'later' }]); const later = jest.fn();
    await expect(runToolCallingLoop({ ...baseOptions, tools: { mutation: { execute: async () => ({ success: true, output: { receiptId: 42 } }) }, later: { execute: later } },
      onToolResult: () => { throw new Error('state write failed'); } })).rejects.toMatchObject({ code: 'uncertain' });
    expect(later).not.toHaveBeenCalled();
    expect(createChatMessage).toHaveBeenLastCalledWith(expect.objectContaining({ metadata: expect.objectContaining({
      code: 'reconciliation_required', toolOutput: expect.objectContaining({ executionReceipt: { success: true, toolName: 'mutation', output: { receiptId: 42 } } }),
    }) }));
  });
  it.each(['result receipt', 'reconciliation receipt'])('preserves uncertainty when saving the %s fails after execution', async boundary => {
    calls([{ name: 'mutation' }, { name: 'later' }]); const later = jest.fn();
    const execute = jest.fn(async () => ({ success: true, output: { receiptId: 42 } }));
    createChatMessage.mockImplementation(async (input: { metadata: { isToolResult?: boolean; code?: string } }) => {
      if (boundary === 'result receipt' ? input.metadata.isToolResult : input.metadata.code === 'reconciliation_required') throw new Error('database unavailable');
      return { id: 1 };
    });
    await expect(runToolCallingLoop({ ...baseOptions, tools: { mutation: { execute }, later: { execute: later } },
      onToolResult: () => { throw new Error('state write failed'); } })).rejects.toMatchObject({ code: 'uncertain' });
    expect(execute).toHaveBeenCalledTimes(1); expect(later).not.toHaveBeenCalled();
  });
  it('overlaps only declared reads and consumes their results before a mutation', async () => {
    calls([{ name: 'get_businessprofiles' }, { name: 'get_brandtoolkits' }, { name: 'mutation' }]);
    let active = 0; let max = 0; const applied: string[] = [];
    const read = async () => { active++; max = Math.max(max, active); await new Promise(resolve => setTimeout(resolve,5)); active--; return { success: true }; };
    const mutate = async () => { expect(active).toBe(0); expect(applied).toEqual(['get_businessprofiles','get_brandtoolkits']); return { success: true }; };
    const result = await runToolCallingLoop({ ...baseOptions, maxIterations: 1, tools: { get_businessprofiles: { execute: read }, get_brandtoolkits: { execute: read }, mutation: { execute: mutate } }, onToolResult: name => { applied.push(name); } });
    expect(max).toBe(2); expect(result.toolResults.map(item => item.toolCallId)).toEqual(['call-0','call-1','call-2']);
  });
});
