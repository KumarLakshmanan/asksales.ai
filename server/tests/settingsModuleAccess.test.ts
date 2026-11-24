import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { withBusinessScope } from '../tenancy/businessContext.js';

const handler = jest.fn((_req: Request, res: Response) => res.json({ reached: true }));
const upload = jest.fn((_req: Request, _res: Response, next: NextFunction) => next());
const access = jest.fn<(userId: number) => Promise<Array<{ key: string; enabled: boolean; status: string }>>>();
let authenticated = true;
let actorUserId = 7;
const pass = (_req: Request, _res: Response, next: NextFunction) => next();
const schema = { partial: () => schema };
const handlers = (...names: string[]) => Object.fromEntries(names.map(name => [name, handler]));

// Exercise the production router and module gate, including their registration
// order. Business/provider/storage handlers terminate in spies instead of writes.
jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticateToken: (req: Request, res: Response, next: NextFunction) => {
    if (!authenticated) return res.status(401).json({ error: 'Authentication required' });
    req.user = { id: actorUserId } as Request['user'];
    return withBusinessScope({ userId: 7, businessProfileId: 101, actorUserId }, next);
  },
}));
jest.unstable_mockModule('../models/platformAccess/functions.js', () => ({
  getEffectiveModuleAccess: access, getMaintenanceSettings: jest.fn(),
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../routes/outreachAssistants.routes.js', () => ({ default: express.Router() }));
jest.unstable_mockModule('../middleware/validation.js', () => ({
  validateBody: () => pass, validateParams: () => pass, commonSchemas: { id: schema },
}));
jest.unstable_mockModule('../middleware/schemas.js', () => ({ businessProfileSchema: schema, createBusinessProfileSchema: schema }));
jest.unstable_mockModule('../controllers/businessStaffController.js', () => handlers(
  'getBusinessInvitations', 'acceptBusinessStaffInvitation', 'getBusinessStaff', 'addBusinessStaff', 'updateBusinessStaff', 'removeBusinessStaff',
));
jest.unstable_mockModule('../controllers/supportDocumentLibraryController.js', () => handlers(
  'listSupportDocuments', 'createSupportDocument', 'updateSupportDocument', 'publishSupportDocument', 'withdrawSupportDocument', 'downloadSupportDocument',
));
jest.unstable_mockModule('../controllers/settingsController.js', () => handlers(
  'getLeadSettings', 'updateLeadSettings', 'getOutreachSettings', 'updateOutreachSettings', 'getUserPreferences', 'updateUserPreferences',
  'getIntegrationFollowUpSettings', 'updateIntegrationFollowUpSettings',
));
jest.unstable_mockModule('../controllers/userProfileController.js', () => handlers(
  'getUserProfileHandler', 'updateUserProfileHandler', 'changePasswordHandler', 'getNotificationPreferencesHandler', 'updateNotificationPreferencesHandler',
));
jest.unstable_mockModule('../controllers/businessProfilesController.js', () => handlers(
  'getBusinessProfiles', 'getBusinessProfile', 'createBusinessProfile', 'updateBusinessProfile', 'deleteBusinessProfile', 'archiveBusinessProfile',
  'setDefaultBusinessProfile', 'getActiveBusinessCategories',
));
jest.unstable_mockModule('../controllers/knowledgeBaseController.js', () => ({ ...handlers(
  'getKnowledgeBaseEntries', 'getKnowledgeBaseEntry', 'getKnowledgeBaseExtractedText', 'createKnowledgeBaseEntry', 'updateKnowledgeBaseEntry',
  'reprocessKnowledgeBaseFile', 'deleteKnowledgeBaseEntry', 'uploadKnowledgeBaseFile', 'createQAEntry',
), uploadMiddleware: upload }));
jest.unstable_mockModule('../controllers/knowledgeGovernanceController.js', () => handlers(
  'listKnowledgeVersions', 'publishKnowledgeVersion', 'quarantineKnowledgeVersion', 'updateKnowledgeDraftScope', 'withdrawKnowledgeEntry',
  'testKnowledgeRetrieval', 'createKnowledgeVersionDraft',
));
jest.unstable_mockModule('../controllers/adminApiCredentialsController.js', () => handlers('getApiCredentialsSummary', 'getUserApiCredentials'));
jest.unstable_mockModule('../controllers/storageController.js', () => handlers(
  'getMyStorageUsage', 'uploadMyFile', 'getMyFiles', 'deleteMyFile', 'deleteMyFiles', 'checkUploadAllowed', 'downloadMyFile', 'renameMyFile',
));
jest.unstable_mockModule('../controllers/autonomousAdsController.js', () => ({ ...handlers(
  'getAdSettings', 'getAdAutonomySettings', 'updateAdSettings', 'updateAdAutonomySettings',
), adSettingsSchema: schema, adAutonomySettingsSchema: schema }));
jest.unstable_mockModule('../controllers/supportMediaGalleryController.js', () => ({ ...handlers(
  'createSupportMediaGallery', 'downloadSupportMediaAsset', 'getSupportMediaGallery', 'listSupportMediaGalleries', 'replaceSupportMediaAsset',
  'retireSupportMediaGallery', 'retireSupportMediaAsset', 'retrySupportMediaScans', 'reviewSupportMediaAsset', 'listUncertainMediaDeliveries',
  'reconcileMediaDelivery', 'retryMediaDelivery', 'updateSupportMediaAsset', 'updateSupportMediaGallery', 'uploadSupportMediaAssets',
), supportMediaReplaceUpload: upload, supportMediaUpload: upload }));
jest.unstable_mockModule('../controllers/storageWorkspaceController.js', () => handlers(
  'getStorageWorkspace', 'getStorageWorkspaceFiles', 'getStorageWorkspaceFile', 'changeStorageWorkspace', 'getStorageActorFolders',
  'getStorageActivity', 'streamStorageFile', 'getStorageThumbnail', 'createStorageDownload', 'redeemStorageDownload',
));

const settings = (await import('../routes/settings.routes.js')).default;
const { requireModuleAccess } = await import('../middleware/platformAccess.js');
const app = express();
app.use(express.json());
app.use('/api/settings', settings);
// Canonical policy controls use the same production gate as index.ts.
app.use('/api/knowledge-base', (req, _res, next) => { req.user = { id: 7 } as Request['user']; next(); }, requireModuleAccess('knowledge_base'));
app.get('/api/knowledge-base', handler);
app.use('/api/storage', (req, _res, next) => { req.user = { id: 7 } as Request['user']; next(); }, requireModuleAccess('storage'));
app.get('/api/storage/files', handler);

const paths = [
  ['get', '/api/settings/knowledge-base', 'knowledge_base'],
  ['post', '/api/settings/knowledge-base', 'knowledge_base'],
  ['post', '/api/settings/knowledge-base/upload', 'knowledge_base'],
  ['post', '/api/settings/knowledge-base/1/versions/2/publish', 'knowledge_base'],
  ['delete', '/api/settings/knowledge-base/1', 'knowledge_base'],
  ['get', '/api/settings/storage/workspace', 'storage'],
  ['post', '/api/settings/storage/workspace/actions', 'storage'],
  ['post', '/api/settings/storage/workspace/download', 'storage'],
  ['post', '/api/settings/storage/files', 'storage'],
  ['get', '/api/settings/storage/files/1/download', 'storage'],
  ['post', '/api/settings/storage/files/bulk-delete', 'storage'],
] as const;
function send(method: typeof paths[number][0], path: string) {
  return request(app)[method](path).send({});
}
beforeEach(() => {
  jest.clearAllMocks(); authenticated = true; actorUserId = 7;
  access.mockResolvedValue(['knowledge_base', 'storage', 'performance_marketing'].map(key => ({ key, enabled: true, status: 'available' })));
});

describe('settings aliases enforce the same module policy as canonical domains', () => {
  it.each(paths)('denies disabled module before %s %s reaches a handler', async (method, path, key) => {
    access.mockResolvedValue([{ key, enabled: false, status: 'disabled' }]);
    const result = await send(method, path);
    expect(result.status).toBe(403); expect(result.body).toMatchObject({ code: 'MODULE_UNAVAILABLE', module: key });
    expect(handler).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
  });
  it.each(paths)('denies maintenance before %s %s reaches a handler', async (method, path, key) => {
    access.mockResolvedValue([{ key, enabled: false, status: 'maintenance' }]);
    const result = await send(method, path);
    expect(result.status).toBe(503); expect(result.headers['retry-after']).toBe('300');
    expect(result.body.code).toBe('MODULE_MAINTENANCE'); expect(handler).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
  });
  it.each(['knowledge_base', 'storage'] as const)('fails closed if %s access lookup fails or returns no entry', async key => {
    const path = key === 'storage' ? '/api/settings/storage/workspace' : '/api/settings/knowledge-base';
    access.mockRejectedValueOnce(new Error('Fixture lookup outage'));
    expect((await request(app).get(path)).status).toBe(503);
    access.mockResolvedValueOnce([]); expect((await request(app).get(path)).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });
  it.each(['knowledge_base', 'storage'] as const)('matches canonical denial and permits enabled %s requests', async key => {
    const alias = key === 'storage' ? '/api/settings/storage/workspace' : '/api/settings/knowledge-base';
    const canonical = key === 'storage' ? '/api/storage/files' : '/api/knowledge-base';
    access.mockResolvedValue([{ key, enabled: false, status: 'available' }]); // Per-account denial.
    expect((await request(app).get(alias)).status).toBe(403); expect((await request(app).get(canonical)).status).toBe(403);
    access.mockResolvedValue([{ key, enabled: true, status: 'available' }]);
    expect((await request(app).get(alias)).status).toBe(200); expect((await request(app).get(canonical)).status).toBe(200);
  });
  it('uses the selected business owner when the actor is staff', async () => {
    actorUserId = 99;
    expect((await request(app).get('/api/settings/storage/workspace')).status).toBe(200);
    expect(access).toHaveBeenCalledWith(7);
  });
  it('keeps authentication before alias access checks and handlers', async () => {
    authenticated = false;
    expect((await request(app).get('/api/settings/knowledge-base')).status).toBe(401);
    expect(access).not.toHaveBeenCalled(); expect(handler).not.toHaveBeenCalled();
  });
  it('preserves unrelated account recovery settings', async () => {
    access.mockResolvedValue([]);
    expect((await request(app).get('/api/settings/profile')).status).toBe(200);
    expect(access).not.toHaveBeenCalled();
  });
});
