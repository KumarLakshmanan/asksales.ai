import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import { withBusinessScope } from '../tenancy/businessContext.js';

const cached = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const createKnowledge = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const saveAnalysis = jest.fn<(...args: unknown[]) => Promise<void>>();
const completion = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const emit = jest.fn();
const html = '<html><head><style>:root{--primary:#7c3aed}body{font-family:Inter,sans-serif;color:#202020}.button{background:#7c3aed}</style></head><body><h1>Creator Studio</h1><p>Practical tutorials and community support for independent creators.</p><a href="mailto:hello@creator.example">Contact</a></body></html>';
const text = 'Creator Studio offers practical tutorials and supports a community of independent creators. Our lessons help people write, design and publish useful work. Contact hello@creator.example to learn more.';
const fetchPage = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('../models/knowledgeBase/functions.js', () => ({ KnowledgeBaseModel: { findBySourceUrl: cached, create: createKnowledge } }));
jest.unstable_mockModule('../services/workspaceWebsiteAnalysis.js', () => ({ saveWorkspaceWebsiteAnalysis: saveAnalysis }));
jest.unstable_mockModule('../services/WebsiteCrawlerService.js', () => ({ WebsiteCrawlerService: class { fetchPage = fetchPage; extractLinks() { return []; } buildContent() { return text; } } }));
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({ LLMProviderFactory: { createProviderForUser: async () => ({ defaultModel: 'fixture', createChatCompletion: completion }), handleRateLimitError: async () => { throw Error('Provider unavailable'); } } }));
jest.unstable_mockModule('../services/knowledge/KnowledgeGateway.js', () => ({ knowledgeGateway: { retrieveText: async () => '' } }));
jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({ webSocketEmitter: { emit } }));
jest.unstable_mockModule('../services/embeddings/EmbeddingService.js', () => ({ embeddingService: { generateEmbeddingsBatch: async () => ({ vectors: [[0.1, 0.2]], model: 'fixture-embedding' }) } }));
jest.unstable_mockModule('../utils/browserAutomation.js', () => ({ launchSystemChromium: async () => { throw Error('Screenshot service unavailable'); } }));
jest.unstable_mockModule('../services/StorageService.js', () => ({ StorageService: { getInstance: () => ({ upload: async () => ({ url: '/uploads/fixture/image.png' }) }) } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const { analyzeWebsite } = await import('../controllers/setupController.js');
const { db } = await import('../models/db.js');
const { withSetupAnalysisProgress } = await import('../services/setupAnalysisProgress.js');

function response() {
  const state: { status: number; body: Record<string, unknown> } = { status: 200, body: {} };
  const res = { status(code: number) { state.status = code; return res; }, json(body: Record<string, unknown>) { state.body = body; return res; } };
  return { state, res: res as Response };
}
function request(body: Record<string, unknown> = {}, actor = 7) { return { user: { id: actor }, body } as Request; }
async function analyze(body: Record<string, unknown>, businessProfileId = 26) {
  const { state, res } = response();
  await withBusinessScope({ userId: 7, businessProfileId }, () => analyzeWebsite(request(body), res));
  return state;
}

describe('workspace website analysis handoff and recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cached.mockResolvedValue(null);
    createKnowledge.mockResolvedValue({ id: 88 });
    saveAnalysis.mockResolvedValue(undefined);
    completion.mockResolvedValue({ success: true, content: JSON.stringify({ companyName: 'Creator Studio', description: text }) });
    fetchPage.mockResolvedValue({ success: true, _html: html, text, title: 'Creator Studio', url: 'https://creator.example' });
  });

  it('returns only the selected workspace cache and persists its result for toolkit setup', async () => {
    const data = { companyName: 'Saved Studio', screenshotUrl: '/uploads/26/screenshot.png', extractedImages: [{ url: '/uploads/26/image.png' }] };
    cached.mockResolvedValue({ id: 88, processingStatus: 'completed', content: JSON.stringify({ setupExtractionVersion: 3, extractedData: data, pagesScraped: [{ url: 'https://creator.example' }], embeddingsGenerated: true }) });
    const result = await analyze({ url: 'creator.example' });
    expect(cached).toHaveBeenCalledWith(7, 'https://creator.example', 26);
    expect(result).toMatchObject({ status: 200, body: { cached: true, data, kbEntryId: 88, analysisSummary: { pages: 1, knowledgeSaved: true, warnings: [] } } });
    expect(saveAnalysis).toHaveBeenCalledWith(7, 26, 'https://creator.example', data, 88, { pages: 1, knowledgeSaved: true, warnings: [] }, db);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('refreshes stale analysis, saves its knowledge under the current profile, and emits scoped progress', async () => {
    cached.mockResolvedValue({ id: 70, processingStatus: 'completed', content: JSON.stringify({ setupExtractionVersion: 3, extractedData: { companyName: 'Old Studio' } }) });
    const result = await analyze({ url: 'https://creator.example', forceRefresh: true }, 41);
    expect(result).toMatchObject({ status: 200, body: { data: { companyName: 'Creator Studio', email: 'hello@creator.example' }, kbEntryId: 88, analysisSummary: { pages: 1, knowledgeSaved: true } } });
    expect(result.body.cached).toBeUndefined();
    expect(createKnowledge).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, businessProfileId: 41, sourceUrl: 'https://creator.example', processingStatus: 'completed' }), db);
    expect(saveAnalysis).toHaveBeenCalledWith(7, 41, 'https://creator.example', expect.objectContaining({ companyName: 'Creator Studio' }), 88, expect.objectContaining({ knowledgeSaved: true }), db);
    expect(emit.mock.calls.every(call => (call[2] as { businessProfileId: number }).businessProfileId === 41)).toBe(true);
  });

  it('keeps extracted details available when knowledge storage fails and reports the warning', async () => {
    createKnowledge.mockRejectedValueOnce(Error('Knowledge storage unavailable'));
    const result = await analyze({ url: 'creator.example', forceRefresh: true });
    expect(result).toMatchObject({ status: 200, body: { data: { companyName: 'Creator Studio' }, kbEntryId: null, analysisSummary: { knowledgeSaved: false, warnings: [expect.stringContaining('could not be saved')] } } });
    expect(saveAnalysis).toHaveBeenCalledWith(7, 26, 'https://creator.example', expect.any(Object), null, expect.objectContaining({ knowledgeSaved: false }), db);
  });

  it('passes the enlisted executor through the cached profile handoff', async () => {
    const executor = { insert: db.insert, update: db.update };
    cached.mockResolvedValue({ id: 88, processingStatus: 'completed', content: JSON.stringify({ setupExtractionVersion: 3, extractedData: { companyName: 'Cached' } }) });
    await withSetupAnalysisProgress(async () => {}, () => analyze({ url: 'creator.example' }), async work => work(executor));
    expect(saveAnalysis.mock.calls[0]?.[6]).toBe(executor);
    expect(createKnowledge).not.toHaveBeenCalled();
  });

  it('passes the enlisted executor through fresh knowledge and profile handoffs', async () => {
    const executor = { insert: db.insert, update: db.update };
    await withSetupAnalysisProgress(async () => {}, () => analyze({ url: 'creator.example', forceRefresh: true }), async work => work(executor));
    expect(createKnowledge.mock.calls[0]?.[1]).toBe(executor);
    expect(saveAnalysis.mock.calls[0]?.[6]).toBe(executor);
  });

  it('does not replace saved analysis when the website or AI service is unavailable', async () => {
    fetchPage.mockResolvedValueOnce({ success: false });
    expect(await analyze({ url: 'creator.example' })).toMatchObject({ status: 422 });
    completion.mockResolvedValueOnce({ success: false, error: 'Provider unavailable' });
    expect(await analyze({ url: 'creator.example' })).toMatchObject({ status: 503 });
    expect(saveAnalysis).not.toHaveBeenCalled();
    expect(createKnowledge).not.toHaveBeenCalled();
  });

  it('requires an owned active workspace and rejects requests before crawling', async () => {
    const unscoped = response();
    await analyzeWebsite(request({ url: 'creator.example' }), unscoped.res);
    expect(unscoped.state.status).toBe(409);
    const member = response();
    await withBusinessScope({ userId: 7, actorUserId: 9, businessProfileId: 26, role: 'member' }, () => analyzeWebsite(request({ url: 'creator.example' }, 9), member.res));
    expect(member.state.status).toBe(403);
    expect(await analyze({})).toMatchObject({ status: 400 });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('uses the requested website when the HTTP scheme is uppercase', async () => {
    expect(await analyze({ url: 'HTTPS://creator.example', forceRefresh: true })).toMatchObject({ status: 200 });
    expect(fetchPage).toHaveBeenCalledWith('HTTPS://creator.example');
    expect(createKnowledge).toHaveBeenCalledWith(expect.objectContaining({ sourceUrl: 'HTTPS://creator.example' }), db);
  });

  it.each(['ftp://creator.example', 'file://creator.example/path', 'https://user:password@creator.example'])('rejects unsupported or credentialed website %s before any provider work', async (url) => {
    expect(await analyze({ url, forceRefresh: true })).toMatchObject({ status: 400 });
    expect(cached).not.toHaveBeenCalled();
    expect(fetchPage).not.toHaveBeenCalled();
    expect(completion).not.toHaveBeenCalled();
    expect(createKnowledge).not.toHaveBeenCalled();
  });
});
