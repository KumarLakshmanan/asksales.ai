import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import sharp from 'sharp';
import { currentBusinessScope, withBusinessScope } from '../tenancy/businessContext.js';
import { currentBillingScope, withBillingScope } from '../tenancy/billingContext.js';

// Actual production Router, upload controllers, multer and request-stream events.
// Only authorization adapters, storage and persistence are synthetic. No DSN or
// provider is loaded. The two accepted memberships deliberately have different
// resource owners and actors so dropping ALS cannot fall back to the right owner.
const fixtures = {
  '9': { userId: 7, actorUserId: 9, businessProfileId: 101, organizationId: 70 },
  '19': { userId: 17, actorUserId: 19, businessProfileId: 202, organizationId: 80 },
};
const boundaries: Array<{ owner: number; profile?: number; organization?: number; actor?: number }> = [];
function boundary(owner: number) {
  const business = currentBusinessScope(); const billing = currentBillingScope();
  boundaries.push({ owner, profile: business?.businessProfileId, organization: billing?.organizationId, actor: billing?.actorUserId });
  if (!business || !billing || business.userId !== owner || business.actorUserId !== billing.actorUserId) throw new Error('Synthetic boundary requires the validated scopes');
}
const upload = jest.fn<any>(async (_bytes: Buffer, data: any) => {
  boundary(data.userId);
  return { url: `/synthetic/${currentBusinessScope()!.businessProfileId}/file.png`, storageKey: 'synthetic', fileName: 'synthetic.png' };
});
jest.unstable_mockModule('../models/db', () => ({ db: {} }));
jest.unstable_mockModule('../middleware/auth.js', () => ({ authenticateToken: (_req: any, _res: any, next: any) => next() }));
jest.unstable_mockModule('../middleware/platformAccess.js', () => ({ requireModuleAccess: () => (req: any, res: any, next: any) => req.get('X-Synthetic-Module-Denied') ? res.sendStatus(403) : next() }));
jest.unstable_mockModule('../middleware/creditCheck.js', () => ({ requireCredits: (_req: any, _res: any, next: any) => next() }));
jest.unstable_mockModule('../services/StorageService.js', () => {
  const instance = { upload, deleteByUrl: async () => {} };
  return { StorageService: { getInstance: () => instance }, storageService: instance, StorageLimitError: class StorageLimitError extends Error {} };
});
jest.unstable_mockModule('../models/contentAssets/functions', () => ({ ContentAssetModel: {
  findByIdForUser: async (id: number, owner: number) => { boundary(owner); return id === 501 ? { id, userId: owner, content: '{}', status: 'draft', version: 1 } : undefined; },
} }));
jest.unstable_mockModule('../models/brandToolkits/functions', () => ({ userHasBrandToolkits: async () => true, BrandToolkitModel: {
  findByIdAndUser: async (id: number, owner: number) => { boundary(owner); return id === 12 ? { id, userId: owner, version: 1, logoUrls: [] } : undefined; },
  updateForUser: async (id: number, owner: number, data: unknown) => { boundary(owner); return { id, ...(data as object) }; },
} }));
jest.unstable_mockModule('../models/chatThreads/functions', () => ({ getChatThreadById: async () => undefined }));
jest.unstable_mockModule('../services/social/OrganicPublishLifecycleService.js', () => ({ updateEditableContentAsset: async (owner: number, id: number, data: object) => { boundary(owner); return { id, ...data }; } }));
jest.unstable_mockModule('../services/social/OrganicPublishingService.js', () => ({ OrganicPublishingError: class extends Error {} }));
jest.unstable_mockModule('../services/content/ContentBrandContextService.js', () => ({ ContentBrandContextError: class extends Error {}, resolveContentBrandContext: jest.fn(), brandContextSnapshot: jest.fn() }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const unused = (module: string, names: string) => jest.unstable_mockModule(module, () => Object.fromEntries(names.split(/\s+/).filter(Boolean).map(name => [name, (_req: any, res: any) => res.sendStatus(501)])));
unused('../controllers/contentEstimateController.js', 'getContentEstimate getImageGenerationOptions');
unused('../controllers/contentStudioController.js', 'generateContentPlan generateAdCopy generateContent generateCreatives getContentPlans generateOutreachCopy generateMetaPrompt generatePromptVariations getMediaStatus generateEmail generateSMS generateSocial generateSocialMessage generateAdCopyContent generateMagicPrompt generateBlogPost enhancePrompt getGenerationStatus generateEmailHtmlTemplate generateImage generateVideo startVideoGeneration checkVideoStatus');
unused('../controllers/contentCalendarController.js', 'getCalendarItems createCalendarItem updateCalendarItem deleteCalendarItem updateCalendarItemStatus getCalendarSummary bulkCalendarAction importCalendarItems');
unused('../controllers/contentTemplatesController.js', 'getContentTemplates getContentTemplateById createContentTemplate updateContentTemplate deleteContentTemplate useTemplate getMostUsedTemplates getContentTemplateCounts duplicateContentTemplate getPredefinedTemplates importPredefinedTemplate getContentTemplateVersions approveContentTemplate');
unused('../controllers/contentAssetPreviewController.js', 'getContentAssetPreviews createContentAssetPreview updateContentAssetPreview');

const { default: router } = await import('../routes/content.routes.js');
const app = express();
app.use((req: any, res, next) => {
  const fixture = fixtures[req.get('X-Synthetic-Actor') as keyof typeof fixtures];
  if (!fixture) return res.sendStatus(401);
  req.user = { id: fixture.actorUserId };
  return withBusinessScope({ ...fixture, role: 'member' }, () => withBillingScope(fixture, next));
});
app.use('/api/content', router);
app.use((error: Error, _req: any, res: any, _next: any) => res.status(400).json({
  error: error.message, profile: currentBusinessScope()?.businessProfileId, organization: currentBillingScope()?.organizationId,
}));
const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#336699' } }).png().toBuffer();
const send = (path: string, field: string, actor = '9', id = '501') => request(app).post(`/api/content${path}`).set('X-Synthetic-Actor', actor)
  .field('assetId', id).field('mediaType', 'image').attach(field, png, { filename: 'synthetic.png', contentType: 'image/png' });
beforeEach(() => { jest.clearAllMocks(); boundaries.length = 0; });

describe('Content multipart retains Data business and Tenant billing scopes', () => {
  it.each([
    { path: '/assets/upload', field: 'file' },
    { path: '/brand-toolkits/12/logo', field: 'logo' },
    { path: '/brand-toolkits/upload-logo', field: 'logo' },
    { path: '/brand-toolkits/upload-image', field: 'image' },
  ])('$path reaches its real controller and scoped storage handoff', async ({ path, field }) => {
    const response = await send(path, field);
    expect(response.status).toBe(200); expect(response.body.success).toBe(true);
    expect(upload).toHaveBeenCalled();
    expect(boundaries.length).toBeGreaterThan(0);
    expect(boundaries.every(value => value.owner === 7 && value.profile === 101 && value.organization === 70 && value.actor === 9)).toBe(true);
  });
  it('keeps concurrent actors and selected businesses isolated across multipart streams', async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => send('/assets/upload', 'file', index % 2 ? '19' : '9')));
    expect(responses.map(value => value.status)).toEqual(Array(6).fill(200));
    expect(boundaries.every(value => value.owner === 7 ? value.profile === 101 && value.organization === 70 && value.actor === 9 : value.owner === 17 && value.profile === 202 && value.organization === 80 && value.actor === 19)).toBe(true);
  });
  it('keeps parser errors in the same scope without storing bytes', async () => {
    const response = await request(app).post('/api/content/assets/upload').set('X-Synthetic-Actor', '9').attach('file', Buffer.from('text'), { filename: 'bad.txt', contentType: 'text/plain' });
    expect(response.status).toBe(400); expect(response.body).toMatchObject({ profile: 101, organization: 70 });
    expect(upload).not.toHaveBeenCalled();
  });
  it('still rejects foreign records without storing bytes', async () => {
    const response = await send('/assets/upload', 'file', '9', '999');
    expect(response.status).toBe(404); expect(upload).not.toHaveBeenCalled();
  });
  it('does not bypass the module or authentication gates', async () => {
    expect((await request(app).post('/api/content/assets/upload')).status).toBe(401);
    expect((await request(app).post('/api/content/assets/upload').set('X-Synthetic-Actor', '9').set('X-Synthetic-Module-Denied', '1')).status).toBe(403);
    expect(upload).not.toHaveBeenCalled();
  });
});
