/** generate_social_media_post with number_of_posts: a 30-day Instagram plan is
 * saved as 30 separate drafts, each within the 2,200-character limit. */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const complete = jest.fn<any>();
const createAsset = jest.fn<any>();
const emit = jest.fn();
jest.unstable_mockModule('../models/db', () => ({ db: { select: () => ({}) } }));
jest.unstable_mockModule('../models/companySettings/functions', () => ({ getCompanySettingsByUserId: jest.fn<any>().mockResolvedValue(null) }));
jest.unstable_mockModule('../mastra/utils/providerCompletion.js', () => ({ createCompletionWithProviderFallback: complete }));
jest.unstable_mockModule('../mastra/tools/queueBridge.js', () => ({ shouldUseQueue: () => false, dispatchAndWait: async (_t: unknown, _p: unknown, _c: unknown, direct: () => Promise<unknown>) => direct() }));
jest.unstable_mockModule('../models/contentAssets/functions', () => ({ ContentAssetModel: { create: createAsset } }));
jest.unstable_mockModule('../services/agents/WebSocketEmitter', () => ({ webSocketEmitter: { emit, emitProgressStep: jest.fn(), emitChatResponse: jest.fn() } }));
jest.unstable_mockModule('../services/promptTemplates', () => ({ templateMap: {} }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../services/media/MediaGenerationWorkerFactory', () => ({ createImageGenerationWorker: jest.fn(), createVideoGenerationWorker: jest.fn() }));

const { executeGenerateSocialMediaPost } = await import('../mastra/tools/executors/contentExecutor.js');
const context: any = {
  userId: 7, threadId: 42, widgetId: 88,
  brandToolkit: { id: 12, name: 'QA Brand', voiceDonts: [], logoVisibility: false },
  brandContextSnapshot: {
    businessProfile: { id: 9, userId: 7, restrictions: '', website: 'https://aimplifylabs.com' },
    brandToolkit: { id: 12, userId: 7, voiceDonts: [], logoVisibility: false },
    provenance: { userId: 7, businessProfile: { id: 9, version: 2 }, brandToolkit: { id: 12, version: 3 } },
  },
};
const noMedia = { auto_generate_image: false, auto_generate_video: false, include_image_prompt: false, include_video_prompt: false };
const post = (day: number, length = 600) => ({ day, title: `Idea ${day}`, caption: `Day ${day}. ${'Useful workflow note. '.repeat(Math.ceil(length / 22))}`.slice(0, length), hashtags: ['workflow'], keywords: [] });
const batchReply = (call: any[]) => {
  const prompt = String(call[1].messages[1].content);
  const [, from, to] = prompt.match(/Write posts (\d+) to (\d+)/) || [];
  const posts = Array.from({ length: Number(to) - Number(from) + 1 }, (_, i) => post(Number(from) + i));
  return { success: true, content: JSON.stringify({ posts }) };
};

beforeEach(() => {
  jest.clearAllMocks();
  let id = 1000;
  createAsset.mockImplementation(async (data: Record<string, unknown>) => ({ ...data, id: ++id }));
});

describe('a 30-day Instagram content plan', () => {
  it('saves 30 separate drafts instead of failing on the 2,200-character limit', async () => {
    complete.mockImplementation(async (...args: any[]) => batchReply(args));
    const result: any = await executeGenerateSocialMediaPost({ platform: 'instagram', topic: 'Launch month', number_of_posts: 30, ...noMedia }, context);

    expect(result.success).toBe(true);
    expect(createAsset).toHaveBeenCalledTimes(30);
    for (const [row] of createAsset.mock.calls as any[]) {
      expect(row.type).toBe('social_post');
      expect(row.channel).toBe('instagram');
      expect(row.status).toBe('draft');
      expect(JSON.parse(row.content).caption.length).toBeLessThanOrEqual(2200);
    }
    expect(result.output).toMatchObject({ postCount: 30, savedCount: 30, failedPosts: [], assetId: 1001 });
    expect(result.output.assetIds).toHaveLength(30);
    expect(result.output.status).toBeUndefined();
    expect(result.output.message).toContain('30 of 30 instagram posts saved as separate drafts, each within the 2,200-character limit');
    expect(complete).toHaveBeenCalledTimes(5);
    // Progress reaches the review card.
    const progress = emit.mock.calls.filter(call => call[1] === 'widget_update').map(call => (call[2] as any).widget.progress);
    expect(progress[0]).toMatchObject({ completed: 0, total: 30 });
    expect(progress.at(-1)).toMatchObject({ completed: 30, total: 30 });
  });

  it('shortens an over-limit post and reports a partial result for one that cannot be fixed', async () => {
    complete.mockImplementation(async (...args: any[]) => {
      const prompt = String(args[1].messages[1].content);
      if (prompt.startsWith('Rewrite this post')) {
        return prompt.includes('"day":2') ? { success: true, content: JSON.stringify(post(2, 300)) } : { success: false, error: 'provider down' };
      }
      return { success: true, content: JSON.stringify({ posts: [post(1), post(2, 2600), post(3, 2600)] }) };
    });
    const result: any = await executeGenerateSocialMediaPost({ platform: 'instagram', topic: 'Launch week', number_of_posts: 3, ...noMedia }, context);
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ status: 'partial_success', savedCount: 2, postCount: 3 });
    expect(result.output.failedPosts).toEqual([{ number: 3, reason: expect.stringContaining('exceeds the 2,200-character limit') }]);
    expect(result.output.warnings.join(' ')).toContain('Post 3:');
  });

  it('explains what to change when no post could be generated', async () => {
    complete.mockResolvedValue({ success: false, error: 'provider down' });
    const result: any = await executeGenerateSocialMediaPost({ platform: 'instagram', topic: 'Launch', number_of_posts: 2, ...noMedia }, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain('None of the 2 posts could be generated');
    expect(result.error).toContain('Adjust the review settings and run it again');
    expect(createAsset).not.toHaveBeenCalled();
  });
});

describe('a single post over the limit', () => {
  it('gets one rewrite before saving', async () => {
    complete
      .mockResolvedValueOnce({ success: true, content: JSON.stringify(post(1, 2600)) })
      .mockResolvedValueOnce({ success: true, content: JSON.stringify(post(1, 400)) });
    const result: any = await executeGenerateSocialMediaPost({ platform: 'instagram', topic: 'Launch', ...noMedia }, context);
    expect(result.success).toBe(true);
    expect(createAsset).toHaveBeenCalledTimes(1);
    expect(String((complete.mock.calls[0] as any[])[1].messages[1].content)).toContain('Character limit: 2200');
  });

  it('fails with an actionable message, not an internal one, when it still does not fit', async () => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify(post(1, 2600)) });
    const result: any = await executeGenerateSocialMediaPost({ platform: 'instagram', topic: 'Launch', ...noMedia }, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain('exceeds the 2,200-character limit');
    expect(result.error).toContain('more posts for a multi-day plan');
    expect(result.output).toMatchObject({ retrySafe: true, reason: 'content_validation_failed' });
    expect(createAsset).not.toHaveBeenCalled();
  });
});
