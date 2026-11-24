import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request } from 'express';
import sharp from 'sharp';

// Video uploads are decoded and size-checked, so fixtures must be real images.
// 1280x720 images already meet provider minimums and pass through unchanged.
const realPng = (await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#2563eb' } }).png().toBuffer()).toString('base64');
const realWebp = (await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#2563eb' } }).webp().toBuffer()).toString('base64');

// Exercise the production handlers and validators. Only external providers,
// persistence and delivery queues are replaced; no provider/network calls run.
const complete = jest.fn<any>();
const createAsset = jest.fn<any>();
const dispatch = jest.fn<any>();
const thread = jest.fn<any>();
const retrieve = jest.fn<any>();
const generateImage = jest.fn<any>();
const generateVideo = jest.fn<any>();
const findAsset = jest.fn<any>();
const updateEditable = jest.fn<any>();
const updateAsset = jest.fn<any>();
const emitAsset = jest.fn<any>();
const resolveBrand = jest.fn<(userId: number, body: unknown) => Promise<unknown>>();
const executeDb = jest.fn<(query: unknown) => Promise<{ rows: unknown[] }>>();
const selectRows = jest.fn<() => Promise<unknown[]>>();
const logError = jest.fn();
const logWarn = jest.fn();
const context = {
  businessProfile: { id: 9, version: 2, userId: 7, isApproved: true, website: 'https://aimplifylabs.com', companyName: 'QA Studio', restrictions: '' },
  brandToolkit: { id: 12, version: 3, userId: 7, isApproved: true, name: 'QA Brand', voiceDonts: [], logoVisibility: false },
  provenance: { userId: 7, businessProfile: { id: 9, version: 2 }, brandToolkit: { id: 12, version: 3 } },
};
jest.unstable_mockModule('../services/agents/ContentStudioAgent', () => ({ ContentStudioAgent: class { generateImage = generateImage; generateVideo = generateVideo; } }));
jest.unstable_mockModule('../services/agents/MetaPromptEngine', () => ({ MetaPromptEngine: class {} }));
jest.unstable_mockModule('../services/agents/LLMProviderFactory', () => ({ LLMProviderFactory: { createChatCompletionWithFallback: complete } }));
jest.unstable_mockModule('../models/db', () => ({ db: { execute: executeDb, select: () => ({ from: () => ({ where: () => ({ limit: selectRows }) }) }) } }));
jest.unstable_mockModule('../models/contentAssets/functions', () => ({ ContentAssetModel: { create: createAsset, createOnce: async (row: unknown) => ({ asset: await (createAsset as (value: unknown) => Promise<unknown>)(row), created: true }), findByIdForUser: findAsset, updateForUser: updateAsset } }));
jest.unstable_mockModule('../services/social/OrganicPublishLifecycleService.js', () => ({ updateEditableContentAsset: updateEditable }));
jest.unstable_mockModule('../models/chatThreads/functions.js', () => ({ getChatThreadById: thread }));
jest.unstable_mockModule('../queues/JobDispatcher.js', () => ({ jobDispatcher: { dispatch } }));
jest.unstable_mockModule('../services/NotificationService.js', () => ({ NotificationService: { imageGenerated: jest.fn() } }));
jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({ webSocketEmitter: { emit: emitAsset } }));
jest.unstable_mockModule('../services/knowledge/KnowledgeGateway.js', () => ({ knowledgeGateway: { retrieveText: retrieve } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: logWarn, error: logError, debug: jest.fn() } }));
jest.unstable_mockModule('../services/content/ContentBrandContextService.js', () => ({
  ContentBrandContextError: class extends Error { constructor(readonly code: string, message: string, readonly status: number) { super(message); } },
  resolveContentBrandContext: resolveBrand,
  brandContextSnapshot: (value: unknown) => value,
  formatContentBrandContext: () => 'QA Studio brand. Website https://aimplifylabs.com.',
  formatMediaBrandContext: () => 'QA Studio brand.',
}));
jest.unstable_mockModule('../services/content/BrandMediaComposer.js', () => ({ primaryBrandLogoUrl: () => undefined }));

const handlers = await import('../controllers/contentStudioController.js');
const schemas = await import('../middleware/schemas.js');
const { ContentBrandContextError } = await import('../services/content/ContentBrandContextService.js');
const { withBusinessScope } = await import('../tenancy/businessContext.js');
const cases = [
  { type: 'email_template', handler: handlers.generateEmail, schema: schemas.contentStudioEmailSchema, body: {}, output: { subject: 'QA email', body: 'A useful workflow note.', signature: 'QA Studio' } },
  { type: 'sms_template', handler: handlers.generateSMS, schema: schemas.contentStudioSmsSchema, body: {}, output: { message: 'QA workflow note. Reply STOP to opt out.' } },
  { type: 'social_post', handler: handlers.generateSocial, schema: schemas.contentStudioSocialSchema, body: { platform: 'linkedin' }, output: { caption: 'A useful workflow note.', hashtags: [], keywords: [] } },
  { type: 'social_dm', handler: handlers.generateSocialMessage, schema: schemas.contentStudioSocialMessageSchema, body: { platform: 'linkedin' }, output: { message: 'Hi {{first_name}}, here is a useful workflow note.' } },
  { type: 'ad_copy', handler: handlers.generateAdCopyContent, schema: schemas.contentStudioAdCopyContentSchema, body: { platform: 'meta' }, output: { headline: 'QA Workflow Notes', primaryText: 'Useful workflow information.', description: 'Read the workflow notes.', callToAction: 'LEARN_MORE', displayUrl: 'https://aimplifylabs.com', keywords: [] } },
  { type: 'blog_post', handler: handlers.generateBlogPost, schema: schemas.contentStudioBlogSchema, body: {}, output: { title: 'QA Workflow Notes', content: '# Workflow Notes\nUseful workflow information.', excerpt: 'Practical workflow notes.', tags: [] } },
];
function response() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((body: unknown) => { res.body = body; return res; });
  return res;
}
async function invoke(testCase: typeof cases[number], extra: Record<string, unknown> = {}) {
  const res = response();
  const body = testCase.schema.parse({ prompt: 'Create a factual QA workflow note.', ...testCase.body, ...extra });
  await testCase.handler({ user: { id: 7 }, body } as any, res);
  return res;
}
beforeEach(() => {
  jest.clearAllMocks();
  resolveBrand.mockResolvedValue(context);
  executeDb.mockResolvedValue({ rows: [] });
  selectRows.mockResolvedValue([]);
  createAsset.mockImplementation(async (data: Record<string, unknown>) => ({ ...data, id: 501 }));
  thread.mockResolvedValue({ id: 42, userId: 7 });
  retrieve.mockResolvedValue('');
  dispatch.mockResolvedValue({ jobId: 'mock-media-job' });
});

describe('email generation recovery', () => {
  const email = cases[0];
  it('returns the complete unsaved campaign contract without creating an asset', async () => {
    const output = { ...email.output, greeting: 'Hello {{first_name}},', cta: 'Read the notes.', closing: 'Regards,' };
    complete.mockResolvedValue({ success: true, content: JSON.stringify(output) });
    const res = await invoke(email, { persist: false });
    expect(res.body).toMatchObject({ success: true, emailContent: output });
    expect(JSON.parse(res.body.content)).toEqual(output);
    expect(createAsset).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
  it.each([
    ['No active LLM API keys configured.', 503, 'AI_PROVIDER_NOT_CONFIGURED'],
    ['HTTP 402 insufficient provider credits', 503, 'AI_PROVIDER_CREDITS'],
    ['HTTP 429 rate limit', 503, 'AI_PROVIDER_UNAVAILABLE'],
    ['request timed out', 504, 'AI_PROVIDER_TIMEOUT'],
    ['provider refused the request', 502, 'AI_PROVIDER_FAILED'],
  ])('classifies %s without leaking provider prose or fabricating a draft', async (failure, status, code) => {
    complete.mockResolvedValue({ success: false, error: `${failure} fixture-upstream-secret`, content: JSON.stringify(email.output) });
    const res = await invoke(email);
    expect(res.statusCode).toBe(status);
    expect(res.body).toMatchObject({ success: false, code });
    expect(JSON.stringify(res.body)).not.toContain('fixture-upstream-secret');
    expect(JSON.stringify([...logWarn.mock.calls, ...logError.mock.calls])).not.toContain('fixture-upstream-secret');
    expect(res.body.content).toBeUndefined();
    expect(createAsset).not.toHaveBeenCalled();
    expect(emitAsset).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('accepts the reviewed CTA and preserves it verbatim in the saved draft', async () => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify(email.output) });
    const res = await invoke(email, { cta: 'Read https://example.invalid/review?a=1&b=2.', includeImagePrompt: false });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ persisted: true, assetId: 501, cta: 'Read https://example.invalid/review?a=1&b=2.' });
    expect(JSON.parse((createAsset.mock.calls[0][0] as { content: string }).content).cta).toBe('Read https://example.invalid/review?a=1&b=2.');
  });
  it('keeps reviewed constraints after character 5000 in the provider request', async () => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify(email.output) });
    const res = await invoke(email, { prompt: `${'Background '.repeat(600)}\nDo not include a sales invitation.` });
    expect(res.statusCode).toBe(200);
    expect((complete.mock.calls[0][1] as { messages: Array<{ content: string }> }).messages[1].content).toContain('Do not include a sales invitation.');
  });
  it.each(['', '   ', '\n\t'])('rejects a blank prompt at the request boundary (%j)', prompt => {
    expect(email.schema.safeParse({ prompt }).success).toBe(false);
  });
  it.each([undefined, '', '{"subject":"QA","body":""}', 'provider prose with no JSON'])('rejects invalid or empty successful provider output (%j)', async content => {
    complete.mockResolvedValue({ success: true, content });
    const res = await invoke(email);
    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({ success: false, code: 'AI_PROVIDER_INVALID_RESPONSE' });
    expect(createAsset).not.toHaveBeenCalled();
  });
  it.each(['outage', 'missing receipt'])('explains an unconfirmed save: %s', async outcome => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify(email.output) });
    if (outcome === 'outage') createAsset.mockRejectedValue(new Error('Fixture database outage'));
    else createAsset.mockResolvedValue(undefined);
    const res = await invoke(email);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ success: false, code: 'EMAIL_SAVE_UNCONFIRMED' });
    expect(res.body.error).toMatch(/Check email templates/);
    expect(res.body.content).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('rejects foreign audience context before calling the provider', async () => {
    const res = await invoke(email, { icpId: 901 });
    expect(res.statusCode).toBe(404);
    expect(complete).not.toHaveBeenCalled();
    expect(createAsset).not.toHaveBeenCalled();
  });
  it('rejects foreign thread context before calling the provider', async () => {
    thread.mockResolvedValue({ id: 42, userId: 999 });
    expect((await invoke(email, { threadId: 42 })).statusCode).toBe(404);
    expect(complete).not.toHaveBeenCalled();
    expect(createAsset).not.toHaveBeenCalled();
  });
  it('rejects a foreign or unapproved template before calling the provider', async () => {
    expect((await invoke(email, { templateId: 901 })).statusCode).toBe(404);
    expect(complete).not.toHaveBeenCalled();
    expect(createAsset).not.toHaveBeenCalled();
  });
  it('preserves brand approval and selected business permission failures', async () => {
    resolveBrand.mockRejectedValue(new ContentBrandContextError('BRAND_TOOLKIT_NOT_APPROVED', 'Approve the selected Brand Toolkit.', 409));
    const res = await invoke(email);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('BRAND_TOOLKIT_NOT_APPROVED');
    expect(complete).not.toHaveBeenCalled();
    expect(createAsset).not.toHaveBeenCalled();
  });
  it('uses the business owner for an authorized member without changing the authenticated actor', async () => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify(email.output) });
    const res = response();
    const req = { user: { id: 8 }, body: email.schema.parse({ prompt: 'A factual QA note.', threadId: 42, businessProfileId: 9, brandToolkitId: 12 }) };
    await withBusinessScope({ userId: 7, actorUserId: 8, businessProfileId: 9, role: 'member' }, () => handlers.generateEmail(req as unknown as Request, res));
    expect(res.statusCode).toBe(200);
    expect(req.user.id).toBe(8);
    expect(resolveBrand).toHaveBeenCalledWith(7, { businessProfileId: 9, brandToolkitId: 12 });
    expect(complete).toHaveBeenCalledWith(7, expect.anything());
    expect(createAsset).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, threadId: 42 }));
  });
  it('rejects invalid direct/legacy handler input before context, retrieval or provider work', async () => {
    const res = response();
    await handlers.generateEmail({ user: { id: 7 }, body: { prompt: '   ', unknownSetting: true } } as unknown as Request, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('EMAIL_INPUT_INVALID');
    expect(resolveBrand).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('provider failures on every text generator', () => {
  it.each(cases.slice(1))('returns a classified provider error for $type instead of a generic 500', async (testCase) => {
    complete.mockResolvedValue({ success: false, error: 'No active LLM API keys configured. fixture-upstream-secret' });
    const res = await invoke(testCase);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ success: false, code: 'AI_PROVIDER_NOT_CONFIGURED' });
    expect(res.body.error).not.toMatch(/email/i);
    expect(JSON.stringify(res.body)).not.toContain('fixture-upstream-secret');
    expect(createAsset).not.toHaveBeenCalled();
  });
  it('keeps the email failure message actionable when an unexpected error happens before a draft exists', async () => {
    resolveBrand.mockRejectedValue(new Error('synthetic lookup failure'));
    const res = await invoke(cases[0]);
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ success: false, code: 'EMAIL_GENERATION_FAILED' });
    expect(res.body.error).toMatch(/try again/i);
    expect(res.body.error).not.toContain('synthetic lookup failure');
  });
});

describe('legacy generation canonical dispatch', () => {
  it.each(cases.filter(item => ['email_template', 'social_post', 'blog_post'].includes(item.type)))('saves $type through its current asset handler', async testCase => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify(testCase.output) });
    const res = response();
    const type = testCase.type === 'email_template' ? 'email' : testCase.type === 'blog_post' ? 'blog' : 'social_post';
    await handlers.generateContent({ user: { id: 7 }, body: { content_type: type, topic: 'Create a factual QA workflow note.' } } as any, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.assetId).toBe(501);
    expect(createAsset).toHaveBeenCalledWith(expect.objectContaining({ type: testCase.type, status: 'draft', userId: 7 }));
    expect(generateVideo).not.toHaveBeenCalled();
  });
  it.each(['whitepaper', 'case_study', 'video_script'])('returns an actionable 410 for %s before generation', async content_type => {
    const res = response();
    await handlers.generateContent({ user: { id: 7 }, body: { content_type, topic: 'Create a factual QA workflow note.' } } as any, res);
    expect(res.statusCode).toBe(410);
    expect(res.body).toMatchObject({ code: 'CONTENT_FORMAT_RETIRED', endpoints: { video: '/api/content/studio/video' } });
    expect(complete).not.toHaveBeenCalled();
    expect(createAsset).not.toHaveBeenCalled();
    expect(generateVideo).not.toHaveBeenCalled();
  });
});

const mediaCases = [
  { type: 'image', handler: handlers.generateImage, schema: schemas.contentStudioImageSchema, generate: generateImage, output: { imageUrl: '/uploads/qa.png', mimeType: 'image/png' } },
  { type: 'video', handler: handlers.generateVideo, schema: schemas.contentStudioVideoSchema, generate: generateVideo, output: { videoUrl: '/uploads/qa.mp4', mimeType: 'video/mp4' } },
];
describe('SMS requested constraints', () => {
  const sms = cases.find(item => item.type === 'sms_template')!;
  it('accepts and persists an explicitly requested 320-character draft', async () => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify({ message: 'A'.repeat(300) }) });
    const res = await invoke(sms, { maxCharacters: 320, includeOptOut: false });
    expect(res.statusCode).toBe(200);
    expect(createAsset).toHaveBeenCalledWith(expect.objectContaining({ performance: { maxCharacters: 320, includeOptOut: false } }));
  });
  it('still enforces the default 160-character limit', async () => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify({ message: 'A'.repeat(200) }) });
    const res = await invoke(sms);
    expect(res.statusCode).toBe(502);
    expect(createAsset).not.toHaveBeenCalled();
  });
  it('rejects missing requested opt-out language before saving', async () => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify({ message: 'A useful workflow note.' }) });
    const res = await invoke(sms, { includeOptOut: true });
    expect(res.statusCode).toBe(502);
    expect(createAsset).not.toHaveBeenCalled();
  });
  it('rejects unsupported limits at the request boundary', () => {
    expect(schemas.contentStudioSmsSchema.safeParse({ prompt: 'hello', maxCharacters: 500 }).success).toBe(false);
  });
});
describe('Blog editorial workflow', () => {
  const blog = cases.find(item => item.type === 'blog_post')!;
  it('returns an outline without creating an article asset', async () => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify(blog.output) });
    const res = await invoke(blog, { stage: 'outline' });
    expect(res.body).toMatchObject({ stage: 'outline', persisted: false });
    expect(res.body.outline).toContain('Workflow Notes');
    expect(createAsset).not.toHaveBeenCalled();
  });
  it('requires approval when an outline is supplied for the article', async () => {
    const res = await invoke(blog, { editorial: { outline: '## Introduction', outlineApproved: false } });
    expect(res.statusCode).toBe(400);
    expect(complete).not.toHaveBeenCalled();
  });
  it('persists reviewed metadata and sources with the article', async () => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify(blog.output) });
    const editorial = { outline: '## Workflow Notes', outlineApproved: true, seoTitle: 'Workflow guide', slug: 'workflow-guide', sourceUrls: ['https://aimplifylabs.com/research'] };
    const res = await invoke(blog, { editorial });
    expect(res.body).toMatchObject({ success: true, editorial });
    expect(JSON.parse((createAsset.mock.calls[0][0] as { content: string }).content).editorial).toEqual(editorial);
  });
  it('rejects credential-bearing source URLs', () => {
    expect(schemas.contentStudioBlogSchema.safeParse({ prompt: 'QA', editorial: { sourceUrls: ['https://user:secret@example.com'] } }).success).toBe(false);
  });
  it('does not treat another domain as an internal link', async () => {
    const res = await invoke(blog, { editorial: { internalLinks: ['https://other.example/guide'] } });
    expect(res.statusCode).toBe(400);
    expect(complete).not.toHaveBeenCalled();
  });
});
describe('Content Studio media durable lifecycle', () => {
  async function media(testCase: typeof mediaCases[number], extra: Record<string, unknown> = {}) {
    const res = response();
    await testCase.handler({ user: { id: 7 }, body: testCase.schema.parse({ prompt: 'A neutral QA visual.', saveToAssets: true, threadId: 42, ...extra }) } as any, res);
    return res;
  }
  it('saves the standalone video before background dispatch and never calls a provider inline', async () => {
    dispatch.mockImplementation(async () => {
      expect(createAsset).toHaveBeenCalledWith(expect.objectContaining({ type: 'video', status: 'pending', userId: 7 }));
      return { jobId: 'content-video-501-0' };
    });
    const res = await media(mediaCases[1], { background: true, includeBrandLogo: false, duration: '4', generateAudio: false, image: { base64Data: realPng, mimeType: 'image/png' } });
    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({ success: true, persisted: true, assetId: 501, jobId: 'content-video-501-0' });
    expect(generateVideo).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith('generate_video', expect.objectContaining({ parentAssetId: 501, image: { base64Data: realPng, mimeType: 'image/png' }, brandLogoUrl: null, videoConfig: expect.objectContaining({ durationSeconds: 4, generateAudio: false }) }), expect.anything());
  });
  it('retains an explicit failed draft when background queue dispatch fails', async () => {
    dispatch.mockRejectedValue(new Error('Queue unavailable'));
    const res = await media(mediaCases[1], { background: true });
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ success: false, persisted: true, assetId: 501 });
    expect(updateAsset).toHaveBeenCalledWith(501, 7, expect.objectContaining({ status: 'failed' }));
    expect(generateVideo).not.toHaveBeenCalled();
  });
  it('does not dispatch background video when draft persistence fails', async () => {
    createAsset.mockRejectedValue(new Error('Database unavailable'));
    expect((await media(mediaCases[1], { background: true })).statusCode).toBe(500);
    expect(dispatch).not.toHaveBeenCalled();
    expect(generateVideo).not.toHaveBeenCalled();
  });
  it.each(mediaCases)('saves generated $type with owner and thread', async testCase => {
    testCase.generate.mockResolvedValue({ success: true, ...testCase.output });
    const res = await media(testCase);
    expect(res.body).toMatchObject({ success: true, persisted: true, assetId: 501 });
    expect(createAsset).toHaveBeenCalledWith(expect.objectContaining({ type: testCase.type, userId: 7, threadId: 42, status: 'draft' }));
  });
  it.each(mediaCases)('exposes a generated but unsaved $type', async testCase => {
    testCase.generate.mockResolvedValue({ success: true, ...testCase.output });
    createAsset.mockRejectedValue(new Error('Injected database outage'));
    const res = await media(testCase);
    expect(res.body).toMatchObject({ persisted: false, assetId: null });
    expect(res.body.persistenceWarning).toMatch(/could not be saved/);
  });
  it.each(mediaCases)('blocks foreign thread for $type before provider', async testCase => {
    thread.mockResolvedValue({ id: 42, userId: 999 });
    expect((await media(testCase)).statusCode).toBe(404);
    expect(testCase.generate).not.toHaveBeenCalled();
  });
  it.each(mediaCases)('blocks foreign parent for $type before provider', async testCase => {
    findAsset.mockResolvedValue(undefined);
    expect((await media(testCase, { assetId: 77 })).statusCode).toBe(404);
    expect(testCase.generate).not.toHaveBeenCalled();
  });
  it.each(mediaCases)('does not mutate scheduled parent for $type', async testCase => {
    findAsset.mockResolvedValue({ id: 77, userId: 7, status: 'scheduled' });
    expect((await media(testCase, { assetId: 77 })).statusCode).toBe(409);
    expect(testCase.generate).not.toHaveBeenCalled();
  });
  it.each(mediaCases)('does not save failed $type generation', async testCase => {
    testCase.generate.mockResolvedValue({ success: false, error: 'Injected provider failure' });
    expect((await media(testCase)).statusCode).toBe(500);
    expect(createAsset).not.toHaveBeenCalled();
  });
  it.each(mediaCases)('preserves source MIME for $type generation', async testCase => {
    const source = { base64Data: realWebp, mimeType: 'image/webp' };
    testCase.generate.mockResolvedValue({ success: true, ...testCase.output });
    const res = await media(testCase, testCase.type === 'image' ? { images: [source] } : { image: source });
    expect(res.body.persisted).toBe(true);
    expect(testCase.generate.mock.calls[0][1]).toEqual(testCase.type === 'image' ? [source] : source);
  });
  it('saves an unfinished video as pending with a recoverable operation', async () => {
    generateVideo.mockResolvedValue({ success: true, operationName: 'qa-operation' });
    const res = await media(mediaCases[1]);
    expect(res.body).toMatchObject({ persisted: true, operationName: 'qa-operation', assetId: 501 });
    expect(createAsset).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending', performance: expect.objectContaining({ operationName: 'qa-operation' }) }));
  });
  it.each(mediaCases)('rejects empty success from the $type provider without a library write', async testCase => {
    testCase.generate.mockResolvedValue({ success: true });
    expect((await media(testCase)).statusCode).toBe(502);
    expect(createAsset).not.toHaveBeenCalled();
  });
  it.each(mediaCases)('attaches $type to the same draft through the locked version guard', async testCase => {
    findAsset.mockResolvedValue({ id: 77, userId: 7, status: 'draft', version: 1, content: '{"caption":"Reviewed copy"}' });
    updateEditable.mockResolvedValue({ id: 77 });
    testCase.generate.mockResolvedValue({ success: true, ...testCase.output });
    expect((await media(testCase, { assetId: 77 })).body).toMatchObject({ persisted: true, assetId: 77 });
    expect(updateEditable).toHaveBeenCalledWith(7, 77, expect.objectContaining({ version: 2, content: expect.stringContaining('Reviewed copy') }));
    // No replacement draft: the only new row is the gallery child for the attached media.
    expect(createAsset).toHaveBeenCalledTimes(1);
    expect(createAsset).toHaveBeenCalledWith(expect.objectContaining({ type: testCase.type, parentAssetId: 77, status: 'draft' }));
  });
  it.each(mediaCases)('does not create a replacement $type when the parent starts publishing during generation', async testCase => {
    findAsset.mockResolvedValue({ id: 77, userId: 7, status: 'draft', version: 1, content: '{}' });
    updateEditable.mockRejectedValue(new Error('Publishing has started'));
    testCase.generate.mockResolvedValue({ success: true, ...testCase.output });
    expect((await media(testCase, { assetId: 77 })).body).toMatchObject({ persisted: false, assetId: null });
    expect(createAsset).not.toHaveBeenCalled();
  });
});

describe('Content Studio durable generation contract', () => {
  const companionCases = [cases[2], cases[4]];
  it.each(companionCases)('does not queue companion media for $type without explicit opt-in', async testCase => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify({ ...testCase.output, imagePrompt: 'A neutral image', videoPrompt: 'A neutral video' }) });
    const res = await invoke(testCase);
    expect(res.statusCode).toBe(200);
    expect(res.body.mediaGeneration).toEqual({ imageQueued: false, videoQueued: false, warnings: [] });
    expect(dispatch).not.toHaveBeenCalled();
  });
  for (const mediaGeneration of [{ image: true, video: false }, { image: false, video: true }, { image: true, video: true }]) {
    it.each(companionCases)(`queues only opted-in companion media for $type (${JSON.stringify(mediaGeneration)})`, async testCase => {
      complete.mockResolvedValue({ success: true, content: JSON.stringify({ ...testCase.output, imagePrompt: 'A neutral image', videoPrompt: 'A neutral video' }) });
      const res = await invoke(testCase, { mediaGeneration, threadId: 42 });
      expect(res.statusCode).toBe(200);
      expect(res.body.mediaGeneration).toMatchObject({ imageQueued: mediaGeneration.image, videoQueued: mediaGeneration.video });
      const jobs = dispatch.mock.calls.map(call => call[0]);
      expect(jobs).toEqual([...(mediaGeneration.image ? ['generate_image'] : []), ...(mediaGeneration.video ? ['generate_video'] : [])]);
      expect(dispatch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ userId: 7, parentAssetId: 501, threadId: 42 }));
    });
  }
  it.each(companionCases)('preserves saved $type copy when companion queueing fails', async testCase => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify({ ...testCase.output, imagePrompt: 'A neutral image' }) });
    dispatch.mockRejectedValue(new Error('Queue unavailable'));
    const res = await invoke(testCase, { mediaGeneration: { image: true, video: false } });
    expect(res.body).toMatchObject({ success: true, assetId: 501, mediaGeneration: { imageQueued: false, videoQueued: false, warnings: ['image generation could not be queued'] } });
  });
  it('retains an approved landing-page path and query in the saved ad and response', async () => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify(cases[4].output) });
    const landingPageUrl = 'https://aimplifylabs.com/product/workflows?source=campaign';
    const res = await invoke(cases[4], { landingPageUrl });
    expect(res.statusCode).toBe(200);
    expect(res.body.displayUrl).toBe(landingPageUrl);
    const saved = createAsset.mock.calls[0][0] as { content: string };
    expect(JSON.parse(saved.content).displayUrl).toBe(landingPageUrl);
  });
  it.each(['https://other.example/offer', 'https://user:secret@aimplifylabs.com/offer'])('rejects unsafe ad landing destination %s before the provider call', async landingPageUrl => {
    const res = await invoke(cases[4], { landingPageUrl });
    expect(res.statusCode).toBe(400);
    expect(complete).not.toHaveBeenCalled();
    expect(createAsset).not.toHaveBeenCalled();
  });
  it('rejects non-HTTPS ad destinations at the request boundary', () => {
    expect(schemas.contentStudioAdCopyContentSchema.safeParse({ prompt: 'QA', platform: 'meta', landingPageUrl: 'http://aimplifylabs.com/offer' }).success).toBe(false);
  });
  it.each([true, false])('returns the validated ad destination for the immediate preview (persist=%s)', async persist => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify(cases[4].output) });
    const res = await invoke(cases[4], { persist });
    expect(res.statusCode).toBe(200);
    expect(res.body.displayUrl).toBe('https://aimplifylabs.com');
  });

  it.each(cases)('persists $type with exact identity, ownership and campaign linkage', async testCase => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify(testCase.output) });
    const res = await invoke(testCase, { threadId: 42 });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, assetId: 501 });
    expect(createAsset).toHaveBeenCalledTimes(1);
    expect(createAsset).toHaveBeenCalledWith(expect.objectContaining({ type: testCase.type, userId: 7, threadId: 42, status: 'draft', businessProfileId: 9, brandToolkitId: 12 }));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(cases)('does not report a saved $type when persistence fails', async testCase => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify(testCase.output) });
    createAsset.mockRejectedValue(new Error('Injected database outage'));
    const res = await invoke(testCase);
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(res.body.success).not.toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(cases)('rejects a foreign campaign before generating $type', async testCase => {
    thread.mockResolvedValue({ id: 42, userId: 999 });
    complete.mockResolvedValue({ success: true, content: JSON.stringify(testCase.output) });
    const res = await invoke(testCase, { threadId: 42 });
    expect(res.statusCode).toBe(404);
    expect(complete).not.toHaveBeenCalled();
    expect(createAsset).not.toHaveBeenCalled();
  });

  it.each(cases)('supports preview-only $type without durable writes or media jobs', async testCase => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify(testCase.output) });
    const res = await invoke(testCase, { persist: false });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.assetId).toBeUndefined();
    expect(createAsset).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(cases)('rejects malformed provider output for $type without saving it', async testCase => {
    complete.mockResolvedValue({ success: true, content: '{"unexpected":"payload"}' });
    const res = await invoke(testCase);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(createAsset).not.toHaveBeenCalled();
  });

  it.each(['linkedin', 'twitter', 'facebook', 'instagram', 'all'])('persists the selected social platform %s', async platform => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify(cases[2].output) });
    const res = await invoke(cases[2], { platform });
    expect(res.body).toMatchObject({ success: true, platform, assetId: 501 });
    expect(createAsset).toHaveBeenCalledWith(expect.objectContaining({ channel: platform }));
  });
});
