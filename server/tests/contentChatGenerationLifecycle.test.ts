import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const complete = jest.fn<any>();
const createAsset = jest.fn<any>();
const emit = jest.fn();
const imageWorker = jest.fn<any>();
const videoWorker = jest.fn<any>();
const sourceRows = jest.fn<any>();
const sourceQuery: any = { from: () => sourceQuery, where: () => sourceQuery, orderBy: () => sourceQuery, limit: sourceRows };
jest.unstable_mockModule('../models/db', () => ({ db: { select: () => sourceQuery } }));
jest.unstable_mockModule('../models/companySettings/functions', () => ({ getCompanySettingsByUserId: jest.fn<any>().mockResolvedValue(null) }));
jest.unstable_mockModule('../mastra/utils/providerCompletion.js', () => ({ createCompletionWithProviderFallback: complete }));
jest.unstable_mockModule('../mastra/tools/queueBridge.js', () => ({ shouldUseQueue: () => false, dispatchAndWait: async (_tool: unknown, _payload: unknown, _context: unknown, direct: () => Promise<unknown>) => direct() }));
jest.unstable_mockModule('../models/contentAssets/functions', () => ({ ContentAssetModel: { create: createAsset, createOnce: async (row: unknown) => ({ asset: await (createAsset as (value: unknown) => Promise<unknown>)(row), created: true }) } }));
jest.unstable_mockModule('../services/agents/WebSocketEmitter', () => ({ webSocketEmitter: { emit, emitProgressStep: jest.fn(), emitChatResponse: jest.fn() } }));
jest.unstable_mockModule('../services/promptTemplates', () => ({ templateMap: {} }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../services/media/MediaGenerationWorkerFactory', () => ({ createImageGenerationWorker: imageWorker, createVideoGenerationWorker: videoWorker }));

const executors = await import('../mastra/tools/executors/contentExecutor.js');
const adExecutors = await import('../mastra/tools/executors/adsExecutor.js');
const context: any = {
  userId: 7, threadId: 42,
  brandToolkit: { id: 12, name: 'QA Brand', voiceDonts: [], logoVisibility: false },
  brandContextSnapshot: {
    businessProfile: { id: 9, userId: 7, restrictions: '', website: 'https://aimplifylabs.com' },
    brandToolkit: { id: 12, userId: 7, voiceDonts: [], logoVisibility: false },
    provenance: { userId: 7, businessProfile: { id: 9, version: 2 }, brandToolkit: { id: 12, version: 3 } },
  },
};
const cases = [
  { type: 'email_template', handler: executors.executeGenerateEmailTemplate, input: { recipient_role: 'Operations lead' }, output: { subject: 'QA email', body: 'A useful workflow note.', signature: 'QA Studio' } },
  { type: 'sms_template', handler: executors.executeGenerateSmsTemplate, input: { key_message: 'A useful workflow note.' }, output: { message: 'QA workflow note. Reply STOP to opt out.' } },
  { type: 'social_post', handler: executors.executeGenerateSocialMediaPost, input: { platform: 'linkedin', topic: 'Workflow notes' }, output: { caption: 'A useful workflow note.', hashtags: [], keywords: [] } },
  { type: 'social_dm', handler: executors.executeGenerateSocialChatTemplate, input: { platform: 'linkedin', objective: 'Share workflow notes' }, output: { message: 'Hi {{first_name}}, here is a useful workflow note.' } },
  { type: 'blog_post', handler: executors.executeGenerateBlogPost, input: { topic: 'Workflow notes' }, output: { title: 'QA Workflow Notes', content: '# Workflow Notes\nUseful workflow information.', excerpt: 'Practical workflow notes.', tags: [] } },
  { type: 'ad_copy', handler: adExecutors.executeGenerateAd, input: { platform: 'meta', description_text: 'A useful workflow note.' }, output: { headline: 'QA Workflow Notes', primaryText: 'Useful workflow information.', description: 'Read the workflow notes.', callToAction: 'LEARN_MORE', displayUrl: 'https://aimplifylabs.com', keywords: [] } },
];
const noMedia = { auto_generate_image: false, auto_generate_video: false, include_image_prompt: false, include_video_prompt: false };
beforeEach(() => {
  jest.clearAllMocks();
  createAsset.mockImplementation(async (data: Record<string, unknown>) => ({ ...data, id: 501, createdAt: new Date() }));
});

describe('reviewed ad variation count at execution', () => {
  const ads = [1, 2, 3].map(index => ({ ...cases[5].output, headline: `Workflow note ${index}` }));
  const input = { platform: 'meta' as const, number_of_variations: 3, ...noMedia };
  it('saves all three reviewed variations without media', async () => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify({ ads }) });
    const result = await adExecutors.executeGenerateAd(input, context);
    expect(result).toMatchObject({ success: true, output: { totalVariations: 3 } });
    expect(createAsset).toHaveBeenCalledTimes(3);
    expect(imageWorker).not.toHaveBeenCalled();
    expect(videoWorker).not.toHaveBeenCalled();
  });
  it('repairs all variations when a later variation fails compliance', async () => {
    complete.mockResolvedValueOnce({ success: true, content: JSON.stringify({ ads: ads.map((ad, index) => index === 1 ? { ...ad, primaryText: 'Guaranteed results.' } : ad) }) })
      .mockResolvedValueOnce({ success: true, content: JSON.stringify({ ads }) });
    const result = await adExecutors.executeGenerateAd(input, context);
    expect(result).toMatchObject({ success: true, output: { totalVariations: 3 } });
    expect(createAsset).toHaveBeenCalledTimes(3);
    expect(complete).toHaveBeenCalledTimes(2);
    const repair = (complete.mock.calls[1][1] as { messages: Array<{ content: string }> }).messages;
    expect(repair[0].content).toContain('exactly 3');
    for (const ad of ads) expect(repair[1].content).toContain(ad.headline);
  });
  it.each(['initial', 'repair'])('rejects a single-copy %s response before any asset or media write', async stage => {
    if (stage === 'repair') complete.mockResolvedValueOnce({ success: true,
      content: JSON.stringify({ ads: ads.map(ad => ({ ...ad, primaryText: 'Guaranteed results.' })) }) });
    complete.mockResolvedValue({ success: true, content: JSON.stringify({ ads: [ads[0]] }) });
    const result = await adExecutors.executeGenerateAd(input, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Expected 3');
    expect(createAsset).not.toHaveBeenCalled();
    expect(imageWorker).not.toHaveBeenCalled();
    expect(videoWorker).not.toHaveBeenCalled();
  });
});

describe('campaign WhatsApp draft generation', () => {
  it('saves a template draft without submitting it to Meta', async () => {
    const result = await executors.executeGenerateWhatsappTemplate({ template_name: 'qa_workflow_note', body_text: 'A neutral workflow note.' }, context);
    expect(result).toMatchObject({ success: true, output: { assetId: 501 } });
    expect(createAsset).toHaveBeenCalledWith(expect.objectContaining({ type: 'whatsapp_template', status: 'draft', userId: 7, threadId: 42 }));
    expect(complete).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(7, 'open_tab', expect.objectContaining({ thread_id: 42, tabType: 'content-whatsapp', data: { type: 'whatsapp', assetId: 501 } }));
  });
  it('does not report saved when WhatsApp draft persistence fails', async () => {
    createAsset.mockRejectedValue(new Error('Injected persistence outage'));
    expect((await executors.executeGenerateWhatsappTemplate({ template_name: 'qa_workflow_note', body_text: 'A neutral workflow note.' }, context)).success).toBe(false);
  });
  it('does not report saved or open a tab when the database returns no asset', async () => {
    createAsset.mockResolvedValue(undefined);
    const result = await executors.executeGenerateWhatsappTemplate({ template_name: 'qa_workflow_note', body_text: 'A neutral workflow note.' }, context);
    expect(result.success).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
});

const imageGenerate = jest.fn<any>();
const videoGenerate = jest.fn<any>();
const mediaCases = [
  { type: 'image', handler: executors.executeGenerateImage, generate: imageGenerate, output: { imageUrl: '/uploads/qa.png', imageData: 'aGVsbG8=', mimeType: 'image/png' }, fromImage: false },
  { type: 'video', handler: executors.executeGenerateVideo, generate: videoGenerate, output: { videoUrl: '/uploads/qa.mp4', mimeType: 'video/mp4' }, fromImage: false },
  { type: 'image', handler: executors.executeGenerateImageFromImage, generate: imageGenerate, output: { imageUrl: '/uploads/qa.png', imageData: 'aGVsbG8=', mimeType: 'image/png' }, fromImage: true },
  { type: 'video', handler: executors.executeGenerateVideoFromImage, generate: videoGenerate, output: { videoUrl: '/uploads/qa.mp4', mimeType: 'video/mp4' }, fromImage: true },
];
describe('campaign chat media generation and source identity', () => {
  beforeEach(() => {
    imageWorker.mockReturnValue({ generateFromText: imageGenerate, generateFromImage: imageGenerate });
    videoWorker.mockReturnValue({ generateFromText: videoGenerate, generateFromImage: videoGenerate });
    sourceRows.mockResolvedValue([{ id: 3, userId: 7, type: 'image', content: 'data:image/webp;base64,aGVsbG8=' }]);
  });
  it.each(mediaCases)('honors explicit no-logo exclusions for $type (source-image: $fromImage)', async testCase => {
    testCase.generate.mockResolvedValue({ success: true, ...testCase.output });
    const brandedContext = { ...context, brandToolkit: { ...context.brandToolkit, logoVisibility: true, logoUrl: '/uploads/brand-logo.png', tagline: 'Workspace tagline', videoIntroText: 'Workspace intro' } };
    const result = await testCase.handler({ prompt: 'Clean visual', negative_prompt: 'text, logos, watermarks', source_image_id: '3' } as any, brandedContext);
    expect(result.success).toBe(true);
    const args = testCase.generate.mock.calls[0];
    expect(args.at(-1)).toEqual(expect.objectContaining({ brandLogoUrl: null }));
    expect(args[0]).not.toContain('include subtle brand logo');
    expect(args[0]).not.toContain('Workspace tagline');
    expect(args[0]).not.toContain('Workspace intro');
    if (testCase.type === 'image' && !testCase.fromImage) {
      expect(args[0]).not.toContain('Brand Guidelines');
      expect(args[0]).not.toContain('QA Brand');
    }
  });
  it.each(mediaCases.filter(testCase => testCase.type === 'video'))('never asks the video model to draw the logo or brand text when branding is on (source-image: $fromImage)', async testCase => {
    testCase.generate.mockResolvedValue({ success: true, ...testCase.output });
    const brandedContext = { ...context, brandToolkit: { ...context.brandToolkit, name: 'Todle', primaryBrandColor: '#1d4ed8', logoVisibility: true, logoUrl: '/uploads/brand-logo.png', tagline: 'Learn smarter', videoIntroText: 'Welcome to Todle', videoOutroText: 'Visit todle.ai' } };
    const result = await testCase.handler({ prompt: 'A teacher using a tablet in class', source_image_id: '3' } as any, brandedContext);
    expect(result.success).toBe(true);
    const args = testCase.generate.mock.calls[0];
    // The real logo is overlaid after generation by the media factory.
    expect(args.at(-1)).toEqual(expect.objectContaining({ brandLogoUrl: '/uploads/brand-logo.png' }));
    expect(String(args[0]).startsWith('A teacher using a tablet in class')).toBe(true);
    expect(args[0]).toContain('- Brand: Todle');
    expect(args[0]).toContain('#1d4ed8');
    for (const forbidden of ['logo', 'watermark', 'Learn smarter', 'Welcome to Todle', 'Visit todle.ai', 'tagline', 'intro text', 'outro text']) {
      expect(args[0]).not.toContain(forbidden);
    }
    if (testCase.fromImage) expect(args.at(-1)).toEqual(expect.objectContaining({ imageRole: 'reference' }));
  });
  it('lets chat request the exact first-frame mode for image-to-video', async () => {
    videoGenerate.mockResolvedValue({ success: true, videoUrl: '/uploads/qa.mp4', mimeType: 'video/mp4' });
    await executors.executeGenerateVideoFromImage({ prompt: 'Open on the product shot', source_image_id: '3', image_role: 'start_frame' } as any, context);
    expect(videoGenerate.mock.calls[0].at(-1)).toEqual(expect.objectContaining({ imageRole: 'start_frame' }));
  });
  it.each(mediaCases)('returns a saved $type receipt (source-image: $fromImage)', async testCase => {
    testCase.generate.mockResolvedValue({ success: true, ...testCase.output });
    const result = await testCase.handler({ prompt: 'QA visual', source_image_id: '3' } as any, context);
    expect(result.success).toBe(true);
    expect(result.output?.assetId).toBe(501);
    expect(createAsset).toHaveBeenCalledWith(expect.objectContaining({ type: testCase.type, userId: 7, threadId: 42, status: 'draft' }));
    if (testCase.fromImage) expect(testCase.generate.mock.calls[0].slice(1, 3)).toEqual(['aGVsbG8=', 'image/webp']);
  });
  it.each(mediaCases)('does not report saved $type after persistence failure (source-image: $fromImage)', async testCase => {
    testCase.generate.mockResolvedValue({ success: true, ...testCase.output });
    createAsset.mockRejectedValue(new Error('Injected persistence outage'));
    const result = await testCase.handler({ prompt: 'QA visual', source_image_id: '3' } as any, context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/sav|persist/i);
  });
  it.each(mediaCases)('does not save $type after provider failure (source-image: $fromImage)', async testCase => {
    testCase.generate.mockResolvedValue({ success: false, error: 'Injected provider outage' });
    const result = await testCase.handler({ prompt: 'QA visual', source_image_id: '3' } as any, context);
    expect(result.success).toBe(false);
    expect(createAsset).not.toHaveBeenCalled();
  });
  it.each(mediaCases.filter(testCase => testCase.fromImage))('never substitutes a thread image for an invalid selected source ($type)', async testCase => {
    sourceRows.mockResolvedValueOnce([]).mockResolvedValue([{ id: 99, content: 'data:image/png;base64,aGVsbG8=' }]);
    const result = await testCase.handler({ prompt: 'QA visual', source_image_id: '999' } as any, context);
    expect(result.success).toBe(false);
    expect(sourceRows).toHaveBeenCalledTimes(1);
    expect(testCase.generate).not.toHaveBeenCalled();
  });
  it.each(mediaCases.filter(testCase => testCase.fromImage))('rejects malformed source IDs without looking up another image ($type)', async testCase => {
    const result = await testCase.handler({ prompt: 'QA visual', source_image_id: '3oops' } as any, context);
    expect(result.success).toBe(false);
    expect(sourceRows).not.toHaveBeenCalled();
    expect(testCase.generate).not.toHaveBeenCalled();
  });
});

describe('campaign chat generation durable receipts', () => {
  it('saves the exact blog CTA and propagates reviewed writing constraints', async () => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify(cases[4].output) });
    const result = await executors.executeGenerateBlogPost({ topic: 'NimbusFlow', cta_text: 'Book a demo—no pressure.', content_instructions: 'Use fictional NimbusFlow, never workspace branding.', ...noMedia }, context);
    expect(result.success).toBe(true);
    expect(JSON.parse((createAsset.mock.calls[0][0] as { content: string }).content).content).toContain('Book a demo—no pressure.');
    expect((complete.mock.calls[0][1] as { messages: Array<{ content: string }> }).messages[1].content).toContain('Use fictional NimbusFlow, never workspace branding.');
  });
  it('uses the reviewed approved destination without forcing the workspace name into ad copy', async () => {
    const destination = 'https://aimplifylabs.com/qa-demo';
    complete.mockResolvedValue({ success: true, content: JSON.stringify({ ...cases[5].output, displayUrl: destination }) });
    const result = await adExecutors.executeGenerateAd({ platform: 'meta', landing_url: destination, ...noMedia }, context);
    expect(result.success).toBe(true);
    expect(JSON.parse((createAsset.mock.calls[0][0] as { content: string }).content).displayUrl).toBe(destination);
    const prompt = (complete.mock.calls[0][1] as { messages: Array<{ content: string }> }).messages[1].content;
    expect(prompt).not.toContain('IMPORTANT: Reference the brand name');
    expect(prompt).not.toContain('IMPORTANT: Include the website URL');
  });
  it.each([cases[0], cases[1], cases[2], cases[3]])('does not generate unreviewed companion images for $type', async testCase => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify({ ...testCase.output, imagePrompt: 'Unexpected companion' }) });
    const result = await testCase.handler(testCase.input as any, context);
    expect(result.success).toBe(true);
    expect(imageWorker).not.toHaveBeenCalled();
  });
  it('uses the reviewed campaign sender instead of the model workspace signature', async () => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify(cases[0].output) });
    const result = await executors.executeGenerateEmailTemplate({ recipient_role: 'Sales manager', sender_business_name: 'NimbusFlow', sender_name: 'Taylor', ...noMedia }, context);
    expect(result.success).toBe(true);
    expect(JSON.parse((createAsset.mock.calls[0][0] as { content: string }).content).signature).toBe('Taylor\nNimbusFlow');
  });
  it('preserves the literal SMS CTA after shortening generated copy', async () => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify({ message: 'NimbusFlow supports small sales teams. '.repeat(7) }) });
    const result = await executors.executeGenerateSmsTemplate({ key_message: 'NimbusFlow', call_to_action: 'Book a demo—no pressure.', ...noMedia }, context);
    expect(result.success).toBe(true);
    const message = (createAsset.mock.calls[0][0] as { content: string }).content;
    expect(message).toContain('Book a demo—no pressure.');
    expect(message.length).toBeLessThanOrEqual(160);
  });
  it('preserves the literal DM CTA and content requirements', async () => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify({ fullMessage: 'A useful workflow for your sales team.' }) });
    const result = await executors.executeGenerateSocialChatTemplate({ platform: 'linkedin', objective: 'Introduce NimbusFlow', cta_text: 'Book a demo—no pressure.', content_instructions: 'State this is a fictional product.', ...noMedia }, context);
    expect(result.success).toBe(true);
    expect(JSON.parse((createAsset.mock.calls[0][0] as { content: string }).content).fullMessage).toContain('Book a demo—no pressure.');
    expect((complete.mock.calls[0][1] as { messages: Array<{ content: string }> }).messages[1].content).toContain('State this is a fictional product.');
  });
  it.each(['linkedin', 'twitter', 'facebook', 'instagram', 'all'] as const)('preserves the reviewed social destination %s', async platform => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify(cases[2].output) });
    const result = await executors.executeGenerateSocialMediaPost({ platform, topic: 'QA workflow note', ...noMedia }, context);
    expect(result).toMatchObject({ success: true, output: { assetId: 501 } });
    expect(createAsset).toHaveBeenCalledWith(expect.objectContaining({ channel: platform, status: 'draft' }));
  });

  it.each(cases)('returns saved $type identity after persistence', async testCase => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify(testCase.output) });
    const result = await testCase.handler({ ...testCase.input, ...noMedia } as any, context);
    expect(result.success).toBe(true);
    expect(result.output?.assetId).toBe(501);
    expect(createAsset).toHaveBeenCalledTimes(1);
    expect(createAsset).toHaveBeenCalledWith(expect.objectContaining({ type: testCase.type, userId: 7, threadId: 42, status: 'draft', businessProfileId: 9, brandToolkitId: 12 }));
  });

  it.each(cases)('does not report a saved $type when persistence fails', async testCase => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify(testCase.output) });
    createAsset.mockRejectedValue(new Error('Injected persistence outage'));
    const result = await testCase.handler({ ...testCase.input, ...noMedia } as any, context);
    expect(result.success).toBe(false);
    expect(result.output?.assetId).toBeUndefined();
    expect(result.error).toMatch(/sav|persist/i);
  });

  it.each(cases)('does not save $type after provider failure', async testCase => {
    complete.mockResolvedValue({ success: false, error: 'Injected provider failure' });
    const result = await testCase.handler({ ...testCase.input, ...noMedia } as any, context);
    expect(result.success).toBe(false);
    expect(createAsset).not.toHaveBeenCalled();
  });

  it.each(cases)('does not retain excluded media prompts or invoke workers for $type', async testCase => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify({ ...testCase.output, imagePrompt: 'Unrequested image', videoPrompt: 'Unrequested video', featuredImagePrompt: 'Unrequested cover', imagePrompts: ['Unrequested image'], videoPrompts: ['Unrequested video'] }) });
    const result = await testCase.handler({ ...testCase.input, ...noMedia } as any, context);
    expect(result.success).toBe(true);
    expect((createAsset.mock.calls[0][0] as { content: string }).content).not.toContain('Unrequested');
    expect(imageWorker).not.toHaveBeenCalled();
    expect(videoWorker).not.toHaveBeenCalled();
  });
});

describe('email sequences from one reviewed card', () => {
  const email = (subject: string) => JSON.stringify({ subject, body: `Body for ${subject}.`, signature: 'QA Studio' });
  it('generates and saves one draft per step with the reviewed delays', async () => {
    let id = 700;
    createAsset.mockImplementation(async (data: Record<string, unknown>) => ({ ...data, id: ++id, createdAt: new Date() }));
    complete.mockResolvedValueOnce({ success: true, content: email('Intro') })
      .mockResolvedValueOnce({ success: true, content: email('Quick follow-up') })
      .mockResolvedValueOnce({ success: true, content: email('Last note') });
    const result = await executors.executeGenerateEmailTemplate({ recipient_role: 'CTO', sequence_steps: 3, step_delay_days: [3, 7], ...noMedia }, context);
    expect(result).toMatchObject({ success: true, output: { assetId: 701, assetIds: [701, 702, 703], postCount: 3, savedCount: 3 } });
    expect(result.output.sequence.map((step: { step: number; sendAfterDays: number }) => [step.step, step.sendAfterDays])).toEqual([[1, 0], [2, 3], [3, 7]]);
    expect(createAsset.mock.calls.map(call => (call[0] as { title: string }).title)).toEqual(['Step 1 of 3: Intro', 'Step 2 of 3: Quick follow-up', 'Step 3 of 3: Last note']);
    const prompts = complete.mock.calls.map(call => (call[1] as { messages: Array<{ content: string }> }).messages[1].content);
    expect(prompts[0]).toContain('SEQUENCE STEP 1 OF 3');
    expect(prompts[1]).toContain('sent 3 days after the previous email');
    expect(prompts[2]).toContain('Earlier subject lines: Intro | Quick follow-up');
    expect(result.output.message).toContain('3 of 3 sequence emails saved as drafts');
  });

  it('turns a multi-email reply into an actionable error, not a raw schema dump', async () => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify({ emails: [{ subject: 'A', body: 'B' }] }) });
    const result = await executors.executeGenerateEmailTemplate({ recipient_role: 'CTO', ...noMedia }, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain('incomplete email draft');
    expect(result.error).not.toContain('invalid_type');
    expect(createAsset).not.toHaveBeenCalled();
  });

  it('keeps the saved steps when a follow-up fails', async () => {
    complete.mockResolvedValueOnce({ success: true, content: email('Intro') })
      .mockResolvedValueOnce({ success: true, content: '{"emails": []}' });
    const result = await executors.executeGenerateEmailTemplate({ recipient_role: 'CTO', sequence_steps: 2, ...noMedia }, context);
    expect(result).toMatchObject({ success: true, output: { savedCount: 1, postCount: 2, failedPosts: [{ step: 2 }] } });
    expect(result.output.message).toContain('Step 2 did not generate');
  });
});
