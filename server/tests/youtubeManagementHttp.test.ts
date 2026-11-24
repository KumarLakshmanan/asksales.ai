import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// Exercise the real HTTP router and adapter; Google and stored credentials are synthetic.
let available = true;
const credential = { id: 11, userId: 991, platform: 'youtube', accessToken: 'synthetic-token', accountIdentifier: 'fixture-channel', tokenExpiry: new Date(Date.now() + 86400000), grantedScopes: ['https://www.googleapis.com/auth/youtube.force-ssl'], providerApprovalStatus: 'approved' };
const query: any = { from: () => query, where: () => query, limit: async () => available ? [credential] : [] };
jest.unstable_mockModule('../models/db', () => ({ db: { select: () => query }, pgPool: undefined }));
const list = jest.fn<any>();
type UpdateRequest = { requestBody: { snippet: Record<string, unknown>; status: Record<string, unknown> } };
const update = jest.fn<(input: UpdateRequest) => Promise<{ data: UpdateRequest['requestBody'] }>>();
const playlists = jest.fn<any>();
const captions = jest.fn<any>();
const moderate = jest.fn<any>();
const reply = jest.fn<any>();
jest.unstable_mockModule('googleapis', () => ({ google: {
  auth: { OAuth2: class { setCredentials() {} } },
  youtube: () => ({ videos: { list, update }, playlists: { list: playlists }, captions: { list: captions }, comments: { setModerationStatus: moderate, insert: reply } }),
} }));
const { default: router } = await import('../controllers/youtubeManagementController.js');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { if (req.get('x-fixture-user') === '991') req.user = { id: 991 } as any; next(); });
app.use('/api/youtube/manage', router);
let fetchSpy: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  jest.clearAllMocks(); available = true;
  credential.grantedScopes = ['https://www.googleapis.com/auth/youtube.force-ssl'];
  credential.providerApprovalStatus = 'approved';
  list.mockResolvedValue({ data: { items: [{ id: 'fixture-video', snippet: { title: 'Existing title', description: 'Existing description', tags: ['existing'], categoryId: '22', channelId: 'fixture-channel' }, status: { privacyStatus: 'unlisted', license: 'youtube' } }] } });
  update.mockImplementation(async ({ requestBody }: UpdateRequest) => ({ data: requestBody }));
  playlists.mockResolvedValue({ data: { items: [] } });
  captions.mockResolvedValue({ data: { items: [] } });
  moderate.mockResolvedValue({}); reply.mockResolvedValue({ data: { id: 'fixture-reply' } });
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('External network forbidden in YouTube management fixture'); });
});
afterEach(() => fetchSpy.mockRestore());
const patch = (details: unknown) => request(app).patch('/api/youtube/manage/videos/fixture-video').set('x-fixture-user', '991').send({ credentialId: 11, ...(details as object) });

describe('YouTube management HTTP with simulated Google', () => {
  it('requires an authenticated actor and explicit credential before provider access', async () => {
    expect((await request(app).get('/api/youtube/manage/playlists?credentialId=11')).status).toBe(401);
    expect((await request(app).get('/api/youtube/manage/playlists').set('x-fixture-user', '991')).status).toBe(400);
    expect(playlists).not.toHaveBeenCalled();
  });
  it('rejects disconnected, denied and upload-only credentials without mutations', async () => {
    available = false; expect((await patch({ title: 'Fixture' })).status).toBe(404);
    available = true; credential.providerApprovalStatus = 'denied'; expect((await patch({ title: 'Fixture' })).status).toBe(403);
    credential.providerApprovalStatus = 'approved'; credential.grantedScopes = ['https://www.googleapis.com/auth/youtube.upload'];
    expect((await patch({ title: 'Fixture' })).status).toBe(403);
    expect(update).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
  });
  it('preserves omitted metadata and forwards explicit false values', async () => {
    const res = await patch({ description: 'Reviewed replacement', madeForKids: false, containsSyntheticMedia: false });
    expect(res.status).toBe(200);
    expect(update.mock.calls[0][0].requestBody).toMatchObject({ snippet: { title: 'Existing title', description: 'Reviewed replacement', tags: ['existing'], categoryId: '22' }, status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false, containsSyntheticMedia: false } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it.each([{ title: '' }, { title: 'x'.repeat(101) }, { description: 'é'.repeat(2501) }, { title: '<unreviewed>' }, { tags: ['x'.repeat(501)] }, { privacyStatus: 'friends' }, { license: 'copyright' }])('rejects invalid management metadata %j before updating Google', async details => {
    expect((await patch(details)).status).toBe(422);
    expect(update).not.toHaveBeenCalled();
  });
  it('uses private visibility for a valid native schedule and rejects a public schedule', async () => {
    const publishAt = new Date(Date.now() + 3600000).toISOString();
    expect((await patch({ publishAt, privacyStatus: 'public' })).status).toBe(422);
    expect(update).not.toHaveBeenCalled();
    expect((await patch({ publishAt })).status).toBe(200);
    expect(update.mock.calls[0][0].requestBody.status).toMatchObject({ publishAt, privacyStatus: 'private' });
  });
  it('rejects unknown moderation actions and unsupported assistant-bound replies before Google', async () => {
    expect((await request(app).post('/api/youtube/manage/comments/fixture/moderate').set('x-fixture-user', '991').send({ credentialId: 11, moderationStatus: 'delete-everything' })).status).toBe(422);
    const blocked = await request(app).post('/api/youtube/manage/comments/fixture/replies').set('x-fixture-user', '991').send({ credentialId: 11, text: 'Reply from fixture' });
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ code: 'ASSISTANT_SETUP_REQUIRED', reason: 'unsupported_channel', deliveryAttempted: false, outcomeUncertain: false, retryable: false });
    expect(moderate).not.toHaveBeenCalled(); expect(reply).not.toHaveBeenCalled();
  });
});
