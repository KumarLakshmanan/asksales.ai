/**
 * Content Controller Tests
 * Tests: Content assets, brand toolkit, content templates
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { createHash } from 'node:crypto';

const approvedContentContext = {
  businessProfile: {
    id: 1,
    userId: 1,
    version: 1,
    isApproved: true,
    isDefault: true,
    updatedAt: new Date(),
    companyName: 'Test Company',
    businessName: 'Test Company',
    name: 'Test Company',
    profileType: 'business',
    industry: 'technology',
    website: 'https://test-company.com',
    restrictions: '',
  },
  brandToolkit: {
    id: 1,
    userId: 1,
    version: 1,
    isApproved: true,
    isDefault: true,
    isActive: true,
    updatedAt: new Date(),
    name: 'Test Brand',
    voiceDonts: [],
  },
  provenance: {
    schemaVersion: 1,
    resolvedAt: new Date().toISOString(),
    userId: 1,
    businessProfile: { id: 1, version: 1, selection: 'default', isApproved: true, updatedAt: new Date().toISOString() },
    brandToolkit: { id: 1, version: 1, selection: 'default', isApproved: true, updatedAt: new Date().toISOString(), isDefault: true, isActive: true },
  },
};

jest.unstable_mockModule('../services/content/ContentBrandContextService.js', () => ({
  ContentBrandContextError: class ContentBrandContextError extends Error {},
  resolveContentBrandContext: jest.fn<() => Promise<typeof approvedContentContext>>().mockResolvedValue(approvedContentContext),
  brandContextSnapshot: jest.fn<(context: typeof approvedContentContext) => {
    provenance: typeof approvedContentContext.provenance;
    businessProfile: typeof approvedContentContext.businessProfile;
    brandToolkit: typeof approvedContentContext.brandToolkit;
  }>().mockImplementation((context: typeof approvedContentContext) => ({
    provenance: context.provenance,
    businessProfile: context.businessProfile,
    brandToolkit: context.brandToolkit,
  })),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const listContentTemplatesMock = jest.fn<any>().mockResolvedValue({ templates: [], total: 0 });

// --- Mock ALL dependencies ---
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

// Content Asset Controller deps
jest.unstable_mockModule('../models/contentAssets/functions', () => ({
  ContentAssetModel: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findAll: jest.fn<any>().mockResolvedValue([]),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findAllByUser: jest.fn<any>().mockResolvedValue([]),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findByUser: jest.fn<any>().mockResolvedValue([]),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    countForUser: jest.fn<any>().mockResolvedValue(0),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    countByTypeForUser: jest.fn<any>().mockResolvedValue({}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findByIdForUser: jest.fn<any>().mockResolvedValue(null),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findOtherAssetReferencingMediaUrl: jest.fn<any>().mockResolvedValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateForUser: jest.fn<any>().mockResolvedValue({ id: 1 }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deleteForUser: jest.fn<any>().mockResolvedValue(true),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getByUserId: jest.fn<any>().mockResolvedValue([]),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getById: jest.fn<any>().mockResolvedValue(null),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create: jest.fn<any>().mockResolvedValue({ id: 1, title: 'Test' }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateById: jest.fn<any>().mockResolvedValue({ id: 1 }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deleteById: jest.fn<any>().mockResolvedValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getByUserIdPaginated: jest.fn<any>().mockResolvedValue({ items: [], total: 0 }),
  },
}));
jest.unstable_mockModule('../models/contentAssets/schema', () => ({
  contentAssetsTable: { id: 'id', userId: 'userId', type: 'type', title: 'title' },
  InsertContentAsset: {},
}));
jest.unstable_mockModule('../models/chatThreads/functions', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getChatThreadById: jest.fn<any>().mockResolvedValue(null),
}));
jest.unstable_mockModule('multer', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const multerFn: any = jest.fn<any>().mockReturnValue({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    single: jest.fn<any>().mockReturnValue((req: any, res: any, next: any) => next()),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    array: jest.fn<any>().mockReturnValue((req: any, res: any, next: any) => next()),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  multerFn.diskStorage = jest.fn<any>().mockReturnValue({});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  multerFn.memoryStorage = jest.fn<any>().mockReturnValue({});
  return { default: multerFn };
});
jest.unstable_mockModule('fs', () => ({
  default: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    existsSync: jest.fn<any>().mockReturnValue(true),
    mkdirSync: jest.fn(),
    writeFileSync: jest.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readFileSync: jest.fn<any>().mockReturnValue(''),
    unlinkSync: jest.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readdirSync: jest.fn<any>().mockReturnValue([]),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    statSync: jest.fn<any>().mockReturnValue({ isFile: () => true }),
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  existsSync: jest.fn<any>().mockReturnValue(true),
  mkdirSync: jest.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readdirSync: jest.fn<any>().mockReturnValue([]),
}));

// Brand Toolkit Controller deps
jest.unstable_mockModule('../models/brandToolkits/functions', () => ({
  BrandToolkitModel: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getByUserId: jest.fn<any>().mockResolvedValue([]),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findAllByUser: jest.fn<any>().mockResolvedValue([]),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getById: jest.fn<any>().mockResolvedValue(null),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findByIdAndUser: jest.fn<any>().mockResolvedValue(null),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findDefault: jest.fn<any>().mockResolvedValue(null),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create: jest.fn<any>().mockResolvedValue({ id: 1, name: 'Test Brand' }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateById: jest.fn<any>().mockResolvedValue({ id: 1 }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateForUser: jest.fn<any>().mockResolvedValue({ id: 1 }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deleteById: jest.fn<any>().mockResolvedValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deleteForUser: jest.fn<any>().mockResolvedValue(true),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setDefault: jest.fn<any>().mockResolvedValue({ id: 1, isDefault: true }),
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  userHasBrandToolkits: jest.fn<any>().mockResolvedValue(false),
}));
jest.unstable_mockModule('../models/brandToolkits/schema', () => ({
  brandToolkitsTable: { id: 'id', userId: 'userId', name: 'name', isDefault: 'isDefault' },
  InsertBrandToolkit: {},
}));
jest.unstable_mockModule('fs/promises', () => ({
  default: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mkdir: jest.fn<any>().mockResolvedValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    writeFile: jest.fn<any>().mockResolvedValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    unlink: jest.fn<any>().mockResolvedValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readFile: jest.fn<any>().mockResolvedValue(''),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    access: jest.fn<any>().mockResolvedValue(undefined),
    mkdtemp: jest.fn<(prefix: string) => Promise<string>>().mockResolvedValue('/tmp/test-media'),
    rm: jest.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined),
    stat: jest.fn<(path: string) => Promise<{ size: number }>>().mockResolvedValue({ size: 1 }),
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mkdir: jest.fn<any>().mockResolvedValue(undefined),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writeFile: jest.fn<any>().mockResolvedValue(undefined),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  unlink: jest.fn<any>().mockResolvedValue(undefined),
  // MediaTranscodingService uses node:fs/promises named exports.
  mkdtemp: jest.fn<(prefix: string) => Promise<string>>().mockResolvedValue('/tmp/test-media'),
  rm: jest.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined),
  stat: jest.fn<(path: string) => Promise<{ size: number }>>().mockResolvedValue({ size: 1 }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readFile: jest.fn<any>().mockResolvedValue(Buffer.from('test')),
}));
jest.unstable_mockModule('crypto', () => ({
  createHash,
  default: {
    createHash,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    randomUUID: jest.fn<any>().mockReturnValue('test-uuid'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    randomBytes: jest.fn<any>().mockReturnValue({ toString: () => 'random' }),
    createHmac: jest.fn<(algorithm: string, key: string | Buffer) => { update: () => { digest: () => string } }>()
      .mockReturnValue({ update: () => ({ digest: () => 'test-signature' }) }),
    timingSafeEqual: jest.fn<(first: Buffer, second: Buffer) => boolean>().mockReturnValue(true),
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  randomUUID: jest.fn<any>().mockReturnValue('test-uuid'),
  // YouTube resumable sessions import the node:crypto named exports. Keep the
  // controller test's crypto mock API-compatible without weakening production.
  createHmac: jest.fn<(algorithm: string, key: string | Buffer) => { update: () => { digest: () => string } }>()
    .mockReturnValue({ update: () => ({ digest: () => 'test-signature' }) }),
  timingSafeEqual: jest.fn<(first: Buffer, second: Buffer) => boolean>().mockReturnValue(true),
}));

// Content Templates Controller deps
jest.unstable_mockModule('../models/contentTemplates/functions', () => ({
  ContentTemplateVersionConflictError: class extends Error {},
  listContentTemplates: listContentTemplatesMock,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getContentTemplates: jest.fn<any>().mockResolvedValue([]),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getContentTemplateById: jest.fn<any>().mockResolvedValue(null),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createContentTemplate: jest.fn<any>().mockResolvedValue({ id: 1, name: 'Test' }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateContentTemplate: jest.fn<any>().mockResolvedValue({ id: 1 }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deleteContentTemplate: jest.fn<any>().mockResolvedValue(undefined),
  default: {
    listContentTemplates: listContentTemplatesMock,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getContentTemplates: jest.fn<any>().mockResolvedValue([]),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getContentTemplateById: jest.fn<any>().mockResolvedValue(null),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createContentTemplate: jest.fn<any>().mockResolvedValue({ id: 1, name: 'Test' }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateContentTemplate: jest.fn<any>().mockResolvedValue({ id: 1 }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deleteContentTemplate: jest.fn<any>().mockResolvedValue(undefined),
  },
}));

const { mockAuthRequest, mockRequest, mockResponse } = await import('./helpers/mockHelpers');

// Import controllers
const contentAssetController = await import('../controllers/contentAssetController');
const brandToolkitController = await import('../controllers/brandToolkitController');
const contentTemplatesController = await import('../controllers/contentTemplatesController');

describe('Content Asset Controller', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  describe('GET /api/content/assets', () => {
    it('should return 401 without auth', async () => {
      const req = mockRequest({ query: {} });
      const res = mockResponse();
      await contentAssetController.getContentAssets(req, res);
      expect(res._status).toBe(401);
    });

    it('should return assets for authenticated user', async () => {
      const req = mockAuthRequest(1, { query: {} });
      const res = mockResponse();
      await contentAssetController.getContentAssets(req, res);
      expect(res._status).toBe(200);
      expect(res._json).toEqual([]);
    });

    it('returns an opt-in paginated contract with server search', async () => {
      const req = mockAuthRequest(7, {
        query: { type: 'image', paginated: 'true', limit: '24', offset: '0', search: 'launch' },
      });
      const res = mockResponse();
      await contentAssetController.getContentAssets(req, res);

      expect(res._status).toBe(200);
      expect(res._json).toEqual({ assets: [], total: 0 });
    });

    it('rejects oversized pages and invalid pagination flags', async () => {
      const oversized = mockResponse();
      await contentAssetController.getContentAssets(mockAuthRequest(1, {
        query: { paginated: 'true', limit: '201' },
      }), oversized);
      expect(oversized._status).toBe(400);

      const invalidFlag = mockResponse();
      await contentAssetController.getContentAssets(mockAuthRequest(1, {
        query: { paginated: 'sometimes' },
      }), invalidFlag);
      expect(invalidFlag._status).toBe(400);
    });
  });

  describe('POST /api/content/assets', () => {
    it.each([
      ['', 201],
      ['An explicitly supplied description exceeding the channel limit', 422],
    ])('preserves an explicit ad description %j while enforcing channel limits', async (description, status) => {
      const req = mockAuthRequest(1, { body: {
        type: 'ad_copy', title: 'QA ad draft', channel: 'all', status: 'draft',
        content: JSON.stringify({ headline: 'QA ad draft', primaryText: 'A longer primary message that must not become the optional description.', description, callToAction: 'Learn More', displayUrl: 'https://test-company.com' }),
      } });
      const res = mockResponse();
      await contentAssetController.createContentAsset(req, res);
      expect(res._status).toBe(status);
    });

    it('should return 401 without auth', async () => {
      const req = mockRequest({ body: { type: 'email_template', title: 'Test', content: 'Hello' } });
      const res = mockResponse();
      await contentAssetController.createContentAsset(req, res);
      expect(res._status).toBe(401);
    });

    it('should create asset for authenticated user', async () => {
      const req = mockAuthRequest(1, { body: { type: 'email_template', title: 'Test', content: 'Hello' } });
      const res = mockResponse();
      await contentAssetController.createContentAsset(req, res);
      expect(res._status).toBe(201);
    });

    it('allows canonical personalization variables in draft assets', async () => {
      const req = mockAuthRequest(1, {
        body: {
          type: 'email_template',
          title: 'Personalized draft',
          content: JSON.stringify({ subject: 'Hello', body: 'Hello {{first_name}}' }),
          status: 'draft',
          channel: 'email',
        },
      });
      const res = mockResponse();
      await contentAssetController.createContentAsset(req, res);
      expect(res._status).toBe(201);
    });
  });

  describe('PUT /api/content/assets/:id', () => {
    it('should return 401 without auth', async () => {
      const req = mockRequest({ params: { id: '1' }, body: { title: 'Updated' } });
      const res = mockResponse();
      await contentAssetController.updateContentAsset(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('POST /api/content/assets/:assetId/reschedule', () => {
    it('requires authentication and rejects schedules that are too soon before touching attempts', async () => {
      const unauthenticated = mockResponse();
      await contentAssetController.rescheduleContentAsset(
        mockRequest({ params: { assetId: '1' }, body: { scheduledFor: new Date(Date.now() + 10 * 60_000).toISOString() } }),
        unauthenticated,
      );
      expect(unauthenticated._status).toBe(401);

      const tooSoon = mockResponse();
      await contentAssetController.rescheduleContentAsset(
        mockAuthRequest(1, { params: { assetId: '1' }, body: { scheduledFor: new Date(Date.now() + 30_000).toISOString() } }),
        tooSoon,
      );
      expect(tooSoon._status).toBe(400);
      expect(tooSoon._json).toMatchObject({ error: expect.stringMatching(/at least one minute/) });
    });
  });

  describe('DELETE /api/content/assets/:id', () => {
    it('should return 401 without auth', async () => {
      const req = mockRequest({ params: { id: '1' } });
      const res = mockResponse();
      await contentAssetController.deleteContentAsset(req, res);
      expect(res._status).toBe(401);
    });
  });
});

describe('Brand Toolkit Controller', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  describe('GET /api/content/brand-toolkits', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest();
      const res = mockResponse();
      await brandToolkitController.getBrandToolkits(req, res);
      expect(res._status).toBe(401);
    });

    it('should return toolkits for authenticated user', async () => {
      const req = mockAuthRequest(1);
      const res = mockResponse();
      await brandToolkitController.getBrandToolkits(req, res);
      expect(res._status).toBe(200);
    });
  });

  describe('POST /api/content/brand-toolkits', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ body: { name: 'Test Brand' } });
      const res = mockResponse();
      await brandToolkitController.createBrandToolkit(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('PUT /api/content/brand-toolkits/:id', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { id: '1' }, body: { name: 'Updated' } });
      const res = mockResponse();
      await brandToolkitController.updateBrandToolkit(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('DELETE /api/content/brand-toolkits/:id', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { id: '1' } });
      const res = mockResponse();
      await brandToolkitController.deleteBrandToolkit(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('GET /api/content/brand-toolkits/:id', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { id: '1' } });
      const res = mockResponse();
      await brandToolkitController.getBrandToolkit(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('GET /api/content/brand-toolkits/check', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest();
      const res = mockResponse();
      await brandToolkitController.checkBrandToolkits(req, res);
      expect(res._status).toBe(401);
    });
  });
});

describe('Content Templates Controller', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  describe('GET /api/content/templates', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ query: {} });
      const res = mockResponse();
      await contentTemplatesController.getContentTemplates(req, res);
      expect(res._status).toBe(401);
    });

    it('should return templates for authenticated user', async () => {
      const req = mockAuthRequest(1, { query: {} });
      const res = mockResponse();
      await contentTemplatesController.getContentTemplates(req, res);
      expect(res._status).toBe(200);
      expect(res._json).toEqual([]);
    });

    it('should return a bounded paginated contract with server-side search', async () => {
      listContentTemplatesMock.mockResolvedValueOnce({ templates: [{ id: 2, name: 'Follow up' }], total: 31 });
      const req = mockAuthRequest(1, { query: { type: 'email', search: ' follow ', limit: '24', offset: '24', includePredefined: 'true' } });
      const res = mockResponse();

      await contentTemplatesController.getContentTemplates(req, res);

      expect(res._status).toBe(200);
      expect(res._json).toEqual({ templates: [{ id: 2, name: 'Follow up' }], total: 31 });
      expect(listContentTemplatesMock).toHaveBeenLastCalledWith({
        userId: 1,
        type: 'email',
        search: 'follow',
        brandToolkitId: undefined,
        includePredefined: true,
        limit: 24,
        offset: 24,
      });
    });

    it('should reject an oversized page instead of issuing an unbounded query', async () => {
      const req = mockAuthRequest(1, { query: { limit: '201' } });
      const res = mockResponse();

      await contentTemplatesController.getContentTemplates(req, res);

      expect(res._status).toBe(400);
      expect(res._json.error).toBe('Invalid limit');
    });
  });

  describe('POST /api/content/templates', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ body: { name: 'Test', type: 'email', content: 'Hello' } });
      const res = mockResponse();
      await contentTemplatesController.createContentTemplate(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('PUT /api/content/templates/:id', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { id: '1' }, body: { name: 'Updated' } });
      const res = mockResponse();
      await contentTemplatesController.updateContentTemplate(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('DELETE /api/content/templates/:id', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { id: '1' } });
      const res = mockResponse();
      await contentTemplatesController.deleteContentTemplate(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('GET /api/content/templates/:id', () => {
    it('should return 401 if not authenticated', async () => {
      const req = mockRequest({ params: { id: '1' } });
      const res = mockResponse();
      await contentTemplatesController.getContentTemplateById(req, res);
      expect(res._status).toBe(401);
    });
  });
});
