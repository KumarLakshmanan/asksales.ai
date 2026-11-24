import { beforeEach, expect, it, jest } from '@jest/globals';
const find = jest.fn<any>();
const update = jest.fn<any>();
const check = jest.fn<any>();
jest.unstable_mockModule('../services/agents/ContentStudioAgent', () => ({ ContentStudioAgent: class { checkVideoGenerationStatus = check; } }));
jest.unstable_mockModule('../services/agents/MetaPromptEngine', () => ({ MetaPromptEngine: class {} }));
jest.unstable_mockModule('../models/contentAssets/functions', () => ({ ContentAssetModel: { findByVideoOperationForUser: find, updateForUser: update } }));
jest.unstable_mockModule('../services/social/OrganicPublishLifecycleService.js', () => ({ updateEditableContentAsset: update }));
jest.unstable_mockModule('../models/db', () => ({ db: {} }));
jest.unstable_mockModule('../queues/JobDispatcher.js', () => ({ jobDispatcher: {} }));
jest.unstable_mockModule('../services/NotificationService.js', () => ({ NotificationService: {} }));
jest.unstable_mockModule('../services/knowledge/KnowledgeGateway.js', () => ({ knowledgeGateway: {} }));
jest.unstable_mockModule('../models/chatThreads/functions.js', () => ({ getChatThreadById: jest.fn() }));
const { checkVideoStatus } = await import('../controllers/contentStudioController.js');
const asset = { id: 123, userId: 7, version: 1, status: 'pending', content: '{}', performance: { operationName: 'operations/tour' } };
beforeEach(() => {
  jest.clearAllMocks();
  find.mockResolvedValue(asset);
  update.mockResolvedValue({ ...asset, status: 'draft', videoUrl: '/uploads/tour.mp4' });
  check.mockResolvedValue({ done: true, videoUrl: '/uploads/tour.mp4' });
});
async function request() {
  const res = { status: jest.fn<any>(), json: jest.fn<any>() };
  res.status.mockReturnValue(res);
  await checkVideoStatus({ user: { id: 7 }, params: { operationName: 'operations/tour' }, query: {} } as never, res as never);
  return res;
}
it('rejects an operation without an owned saved asset before calling a provider', async () => {
  find.mockResolvedValue(undefined);
  const res = await request();
  expect(res.status).toHaveBeenCalledWith(404);
  expect(check).not.toHaveBeenCalled();
});
it('returns an exact receipt only after attachment succeeds', async () => {
  const res = await request();
  expect(update).toHaveBeenCalledWith(7, 123, expect.objectContaining({ videoUrl: '/uploads/tour.mp4', version: 2 }));
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ done: true, assetId: 123, persisted: true }));
});
it.each(['throws', 'missing'])('does not report completion when persistence %s', async mode => {
  if (mode === 'throws') update.mockRejectedValueOnce(new Error('database offline'));
  else update.mockResolvedValueOnce(undefined);
  const res = await request();
  expect(res.status).toHaveBeenCalledWith(503);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, done: false, providerDone: true, persisted: false }));
});
it('reuses a persisted completed video without another provider request', async () => {
  find.mockResolvedValue({ ...asset, status: 'draft', videoUrl: '/uploads/tour.mp4' });
  const res = await request();
  expect(check).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ done: true, assetId: 123, persisted: true }));
});
