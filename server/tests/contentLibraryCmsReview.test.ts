import { beforeEach, describe, expect, it, jest } from '@jest/globals';

class CmsPublishingError extends Error { constructor(message: string, public code: string, public statusCode = 400) { super(message); } }
jest.unstable_mockModule('../services/aiVisibility/CmsDraftPublishingService.js', () => ({ CmsPublishingError }));
let rows: unknown[][] = [];
const inserts: Array<{ table: unknown; values: unknown }> = [];
const updates: unknown[] = [];
const tx = {
  select() {
    const query = { from() { return query; }, where() { return query; }, limit() { return query; }, orderBy() { return query; }, for() { return query; }, then(resolve: (value: unknown[]) => unknown) { return Promise.resolve(resolve(rows.shift() || [])); } };
    return query;
  },
  insert(table: unknown) { return { values(values: unknown) { inserts.push({ table, values }); return { returning: async () => [{ id: 77 }], onConflictDoNothing: async () => undefined }; } }; },
  update() { return { set(value: unknown) { updates.push(value); return { where: async () => undefined }; } }; },
};
jest.unstable_mockModule('../models/db.js', () => ({ db: { transaction: async (callback: (value: typeof tx) => unknown) => callback(tx) } }));
const { importBlogForCmsReview, validateBlogCmsImport } = await import('../services/aiVisibility/ContentLibraryCmsReviewService.js');
const project = { id: 2, userId: 7, status: 'active', brandToolkitId: 3, businessProfileId: 4 };
const asset = { id: 9, userId: 7, type: 'blog_post', status: 'draft', version: 2, brandToolkitId: 3, businessProfileId: 4, title: 'Article', content: 'Draft copy', metadata: {} };
beforeEach(() => { rows = []; inserts.length = 0; updates.length = 0; });

describe('content library CMS review import', () => {
  it('links a draft only to a real completed analysis and resets review', async () => {
    rows = [[project], [asset], [], [{ id: 12 }]];
    await expect(importBlogForCmsReview(7, 2, 9, 2)).resolves.toEqual({ linkId: 77, contentAssetId: 9, existing: false });
    expect(inserts[0].values).toEqual({ userId: 7, projectId: 2, auditId: 12, contentAssetId: 9 });
    expect(updates[0]).toMatchObject({ approvalStatus: 'draft', approvedBy: null, metadata: { cmsReviewImport: { auditContextOnly: true } } });
    expect(inserts[1].values).toMatchObject({ generatedAssetLinkId: 77, version: 2, content: 'Draft copy' });
  });
  it('returns the same link on retry without clearing a later approval', async () => {
    rows = [[project], [asset], [{ id: 77, userId: 7, projectId: 2 }]];
    await expect(importBlogForCmsReview(7, 2, 9, 2)).resolves.toMatchObject({ linkId: 77, existing: true });
    expect(updates).toHaveLength(0); expect(inserts).toHaveLength(0);
  });
  it('does not invent an analysis or save anything when none is complete', async () => {
    rows = [[project], [asset], [], []];
    await expect(importBlogForCmsReview(7, 2, 9, 2)).rejects.toMatchObject({ code: 'IMPORT_REQUIRES_AUDIT' });
    expect(updates).toHaveLength(0); expect(inserts).toHaveLength(0);
  });
  it('refuses linking the same draft to another project', async () => {
    rows = [[project], [asset], [{ id: 77, userId: 7, projectId: 99 }]];
    await expect(importBlogForCmsReview(7, 2, 9, 2)).rejects.toMatchObject({ code: 'IMPORT_ALREADY_LINKED' });
  });
  it('enforces both ownership boundaries and brand matching', () => {
    expect(() => validateBlogCmsImport({ ...project, userId: 8 }, asset, 7, 2)).toThrow('own');
    expect(() => validateBlogCmsImport(project, { ...asset, userId: 8 }, 7, 2)).toThrow('own');
    expect(() => validateBlogCmsImport(project, { ...asset, brandToolkitId: 99 }, 7, 2)).toThrow('same Brand Toolkit');
  });
  it('rejects stale versions, non-blog types and active publishing', () => {
    expect(() => validateBlogCmsImport(project, asset, 7, 1)).toThrow('changed');
    expect(() => validateBlogCmsImport(project, { ...asset, type: 'ad_copy' }, 7, 2)).toThrow('Only blog');
    expect(() => validateBlogCmsImport(project, { ...asset, status: 'published' }, 7, 2)).toThrow('Duplicate');
  });
});
