import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { contentAssetsTable } from '../../models/contentAssets/schema.js';
import { aiVisibilityProjectsTable, aiVisibilityAuditsTable, aiVisibilityGeneratedAssetLinksTable, aiVisibilityAssetVersionsTable } from '../../models/aiVisibility/schema.js';
import { CmsPublishingError } from './CmsDraftPublishingService.js';

export function validateBlogCmsImport(project: { userId: number; status: string; brandToolkitId: number | null; businessProfileId: number | null }, asset: { userId: number; type: string; status: string; version: number; brandToolkitId: number | null; businessProfileId: number | null }, userId: number, expectedVersion: number) {
  if (project.userId !== userId || asset.userId !== userId || project.status !== 'active') throw new CmsPublishingError('Choose an active website project and blog draft that you own.', 'IMPORT_OWNERSHIP', 403);
  if (!['blog', 'blog_post'].includes(asset.type)) throw new CmsPublishingError('Only blog drafts can be sent to CMS review.', 'IMPORT_TYPE');
  if (['scheduled', 'processing', 'published'].includes(asset.status)) throw new CmsPublishingError('Duplicate published or scheduled content before sending a separate draft to CMS review.', 'IMPORT_LOCKED', 409);
  if (asset.version !== expectedVersion) throw new CmsPublishingError('The blog changed after you opened this review. Reopen it to review the latest version.', 'IMPORT_VERSION', 409);
  if (!project.brandToolkitId || !project.businessProfileId || project.brandToolkitId !== asset.brandToolkitId || project.businessProfileId !== asset.businessProfileId) throw new CmsPublishingError('The website and blog must use the same Brand Toolkit and business profile.', 'IMPORT_BRAND', 409);
}

/** Link a saved draft to existing exact-version review. Never creates an audit or calls a CMS. */
export async function importBlogForCmsReview(userId: number, projectId: number, contentAssetId: number, expectedVersion: number) {
  return db.transaction(async (tx: typeof db) => {
    const [project] = await tx.select().from(aiVisibilityProjectsTable).where(and(eq(aiVisibilityProjectsTable.id, projectId), eq(aiVisibilityProjectsTable.userId, userId))).limit(1).for('share');
    const [asset] = await tx.select().from(contentAssetsTable).where(and(eq(contentAssetsTable.id, contentAssetId), eq(contentAssetsTable.userId, userId))).limit(1).for('update');
    if (!project || !asset) throw new CmsPublishingError('Website project or blog draft not found.', 'IMPORT_NOT_FOUND', 404);
    validateBlogCmsImport(project, asset, userId, expectedVersion);
    const [existing] = await tx.select().from(aiVisibilityGeneratedAssetLinksTable).where(eq(aiVisibilityGeneratedAssetLinksTable.contentAssetId, contentAssetId)).limit(1);
    if (existing) {
      if (existing.userId !== userId || existing.projectId !== projectId) throw new CmsPublishingError('This draft is already linked to another website. Duplicate it before using a different destination.', 'IMPORT_ALREADY_LINKED', 409);
      return { linkId: existing.id, contentAssetId, existing: true };
    }
    const [audit] = await tx.select().from(aiVisibilityAuditsTable).where(and(eq(aiVisibilityAuditsTable.projectId, projectId), eq(aiVisibilityAuditsTable.userId, userId), inArray(aiVisibilityAuditsTable.status, ['completed', 'completed_with_warnings']))).orderBy(desc(aiVisibilityAuditsTable.createdAt)).limit(1).for('share');
    if (!audit) throw new CmsPublishingError('Complete a website analysis before importing a blog into this project. No analysis or credits were started.', 'IMPORT_REQUIRES_AUDIT', 409);
    const [link] = await tx.insert(aiVisibilityGeneratedAssetLinksTable).values({ userId, projectId, auditId: audit.id, contentAssetId }).returning();
    await tx.update(contentAssetsTable).set({
      approvalStatus: 'draft', approvedBy: null, approvedAt: null,
      metadata: { ...(asset.metadata || {}), cmsReviewImport: { source: 'content_library', importedAt: new Date().toISOString(), auditContextOnly: true, note: 'Imported draft: the associated analysis is website context, not evidence validating every statement in this article.' } },
      updatedAt: new Date(),
    }).where(and(eq(contentAssetsTable.id, contentAssetId), eq(contentAssetsTable.userId, userId)));
    await tx.insert(aiVisibilityAssetVersionsTable).values({ generatedAssetLinkId: link.id, version: asset.version, title: asset.title, content: asset.content, actorUserId: userId }).onConflictDoNothing();
    return { linkId: link.id, contentAssetId, existing: false };
  });
}
