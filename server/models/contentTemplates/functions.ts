import { eq, desc, and, ilike, or, sql, count } from 'drizzle-orm';
import { requireBusinessScope } from '../../tenancy/businessContext.js';
import { TemplateCreateRequestError, type TemplateCreateRequest } from '../../utils/templateCreateRequest.js';
import { db } from '../db';
import { contentStorageOwner, lockContentManagedStorage, releaseContentManagedStorage, syncContentManagedStorage } from '../../services/content/ContentManagedStorageService.js';
import { collectContentManagedReferenceUrls } from '../../utils/contentManagedReferences.js';
import {
  contentTemplatesTable,
  contentTemplateVersionsTable,
  ContentTemplate,
  NewContentTemplate,
  type ContentTemplateVersion,
} from './schema';

export class ContentTemplateVersionConflictError extends Error {
  constructor() {
    super('This template changed while you were editing it. Reload the latest version and try again.');
    this.name = 'ContentTemplateVersionConflictError';
  }
}

function templateSnapshot(template: ContentTemplate): Record<string, unknown> {
  return {
    name: template.name,
    type: template.type,
    subject: template.subject,
    content: template.content,
    htmlContent: template.htmlContent,
    variables: template.variables || [],
    category: template.category,
    tags: template.tags || [],
    description: template.description,
    thumbnailUrl: template.thumbnailUrl,
    brandToolkitId: template.brandToolkitId,
    businessProfileId: template.businessProfileId,
    brandContextSnapshot: template.brandContextSnapshot,
    isApproved: template.isApproved,
    approvedBy: template.approvedBy,
    approvedAt: template.approvedAt?.toISOString() || null,
  };
}

async function recordTemplateVersion(
  tx: typeof db,
  template: ContentTemplate,
  actorUserId: number | null,
): Promise<ContentTemplateVersion> {
  const [version] = await tx.insert(contentTemplateVersionsTable).values({
    templateId: template.id,
    userId: template.userId,
    businessProfileId: template.businessProfileId,
    version: template.version,
    snapshot: templateSnapshot(template),
    createdBy: actorUserId,
  }).returning();
  return version;
}

async function syncTemplateStorage(tx: typeof db, template: ContentTemplate, version?: ContentTemplateVersion) {
  const currentOwner = contentStorageOwner('content_template', template);
  const versionOwner = version && contentStorageOwner('content_template_version', version);
  await syncContentManagedStorage(tx, [
    currentOwner ? { owner: currentOwner, urls: collectContentManagedReferenceUrls(template) } : undefined,
    versionOwner ? { owner: versionOwner, urls: collectContentManagedReferenceUrls(version!.snapshot) } : undefined,
  ]);
}

async function lockTemplate(tx: typeof db, id: number, userId?: number): Promise<ContentTemplate | undefined> {
  const where = and(eq(contentTemplatesTable.id, id), ...(userId === undefined ? [] : [eq(contentTemplatesTable.userId, userId)]));
  const [candidate] = await tx.select().from(contentTemplatesTable).where(where).limit(1);
  if (!candidate) return undefined;
  await lockContentManagedStorage(tx, candidate);
  return (await tx.select().from(contentTemplatesTable).where(where).limit(1).for('update'))[0];
}

// Create a new content template
export async function createContentTemplate(data: NewContentTemplate, request?: TemplateCreateRequest): Promise<ContentTemplate> {
  const scope = request ? requireBusinessScope() : undefined;
  if (scope && (data.userId !== scope.userId || data.businessProfileId !== scope.businessProfileId)) throw new TemplateCreateRequestError('TEMPLATE_CREATE_SCOPE_CONFLICT', 'The template request belongs to a different business.');
  return db.transaction(async (tx: typeof db) => {
    await lockContentManagedStorage(tx, data);
    if (request && scope) {
      // Serialize absent receipt keys too, then commit template, version and receipt together.
      const lock = `template-create:${scope.businessProfileId}:${scope.userId}:${request.key}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`);
      const existing = await tx.execute(sql`SELECT request_hash, state, response_body FROM content_request_receipts
        WHERE business_profile_id=${scope.businessProfileId} AND user_id=${scope.userId} AND request_key=${request.key} FOR UPDATE`);
      const receipt = existing.rows[0] as { request_hash: string; state: string; response_body: ContentTemplate | null } | undefined;
      if (receipt) {
        if (receipt.request_hash !== request.hash) throw new TemplateCreateRequestError('TEMPLATE_CREATE_KEY_CONFLICT', 'This request key belongs to different template content.');
        if (receipt.state !== 'complete' || !receipt.response_body) throw new TemplateCreateRequestError('TEMPLATE_CREATE_UNCONFIRMED', 'This template result is unavailable. Check the template library before starting another creation.', receipt.state === 'expired' ? 410 : 503);
        const replay = receipt.response_body;
        return { ...replay, createdAt: new Date(replay.createdAt), updatedAt: new Date(replay.updatedAt),
          approvedAt: replay.approvedAt ? new Date(replay.approvedAt) : null, lastUsedAt: replay.lastUsedAt ? new Date(replay.lastUsedAt) : null };
      }
    }
    const [template] = await tx.insert(contentTemplatesTable).values(data).returning();
    const version = await recordTemplateVersion(tx, template, data.userId ?? null);
    if (request && scope) await tx.execute(sql`INSERT INTO content_request_receipts
      (business_profile_id, user_id, request_key, request_hash, state, status_code, response_body, completed_at)
      VALUES (${scope.businessProfileId}, ${scope.userId}, ${request.key}, ${request.hash}, 'complete', 201, ${JSON.stringify(template)}::jsonb, NOW())`);
    await syncTemplateStorage(tx, template, version);
    return template;
  });
}

export async function countContentTemplatesByTypeForUser(userId: number): Promise<Record<string, number>> {
  const rows: Array<{ type: string; total: number }> = await db.select({ type: contentTemplatesTable.type, total: count() })
    .from(contentTemplatesTable)
    .where(eq(contentTemplatesTable.userId, userId))
    .groupBy(contentTemplatesTable.type);
  return Object.fromEntries(rows.map((row) => [row.type, Number(row.total)]));
}

export async function listContentTemplates(options: {
  userId: number;
  type?: string;
  search?: string;
  brandToolkitId?: number;
  includePredefined?: boolean;
  limit?: number;
  offset?: number;
}): Promise<{ templates: ContentTemplate[]; total: number }> {
  const visibility = options.includePredefined
    ? or(
        eq(contentTemplatesTable.userId, options.userId),
        and(
          eq(contentTemplatesTable.isPredefined, true),
          eq(contentTemplatesTable.isApproved, true),
        ),
      )
    : eq(contentTemplatesTable.userId, options.userId);
  const conditions = [visibility];
  if (options.type) conditions.push(eq(contentTemplatesTable.type, options.type));
  if (options.brandToolkitId) conditions.push(eq(contentTemplatesTable.brandToolkitId, options.brandToolkitId));
  if (options.search) {
    conditions.push(or(
      ilike(contentTemplatesTable.name, `%${options.search}%`),
      ilike(contentTemplatesTable.content, `%${options.search}%`),
    ));
  }
  const where = and(...conditions);
  let query = db
    .select()
    .from(contentTemplatesTable)
    .where(where)
    .orderBy(desc(contentTemplatesTable.updatedAt), desc(contentTemplatesTable.id))
    .$dynamic();
  query = query.limit(options.limit ?? 200);
  if (options.offset !== undefined) query = query.offset(options.offset);
  const [templates, totalRows] = await Promise.all([
    query,
    db.select({ total: count() }).from(contentTemplatesTable).where(where),
  ]);
  return { templates, total: Number(totalRows[0]?.total || 0) };
}

// Get template by ID
export async function getContentTemplateById(id: number): Promise<ContentTemplate | null> {
  const [template] = await db
    .select()
    .from(contentTemplatesTable)
    .where(eq(contentTemplatesTable.id, id))
    .limit(1);
  return template || null;
}

// Update a content template
export async function updateContentTemplate(
  id: number, 
  data: Partial<Omit<NewContentTemplate, 'id' | 'userId' | 'createdAt'>>
): Promise<ContentTemplate | null> {
  return db.transaction(async (tx: typeof db) => {
    if (!(await lockTemplate(tx, id))) return null;
    const [template] = await tx
    .update(contentTemplatesTable)
    .set({
      ...data,
      updatedAt: new Date()
    })
    .where(eq(contentTemplatesTable.id, id))
    .returning();
    if (template) await syncTemplateStorage(tx, template);
    return template || null;
  });
}

export async function updateContentTemplateForUser(
  id: number,
  userId: number,
  data: Partial<Omit<NewContentTemplate, 'id' | 'userId' | 'createdAt'>>,
  expectedVersion?: number,
): Promise<ContentTemplate | null> {
  return db.transaction(async (tx: typeof db) => {
    const existing = await lockTemplate(tx, id, userId);
    if (!existing) return null;
    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      throw new ContentTemplateVersionConflictError();
    }
    const definedData = Object.fromEntries(
      Object.entries(data).filter(([, value]) => value !== undefined),
    ) as Partial<NewContentTemplate>;
    const approved = definedData.isApproved === true;
    const [template] = await tx
      .update(contentTemplatesTable)
      .set({
        ...definedData,
        isApproved: approved,
        approvedBy: approved ? userId : null,
        approvedAt: approved ? new Date() : null,
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(contentTemplatesTable.id, id), eq(contentTemplatesTable.userId, userId)))
      .returning();
    if (!template) return null;
    const version = await recordTemplateVersion(tx, template, userId);
    await syncTemplateStorage(tx, template, version);
    return template;
  });
}

export async function approveContentTemplateForUser(
  id: number,
  userId: number,
  governance?: {
    businessProfileId: number;
    brandToolkitId: number;
    brandContextSnapshot: Record<string, unknown>;
  },
  expectedVersion?: number,
): Promise<ContentTemplate | null> {
  return db.transaction(async (tx: typeof db) => {
    const existing = await lockTemplate(tx, id, userId);
    if (!existing) return null;
    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      throw new ContentTemplateVersionConflictError();
    }
    const contextChanged = governance
      && (
        existing.businessProfileId !== governance.businessProfileId
        || existing.brandToolkitId !== governance.brandToolkitId
        || JSON.stringify(existing.brandContextSnapshot) !== JSON.stringify(governance.brandContextSnapshot)
      );
    if (existing.isApproved && !contextChanged) return existing;
    const [template] = await tx
      .update(contentTemplatesTable)
      .set({
        ...(governance || {}),
        isApproved: true,
        approvedBy: userId,
        approvedAt: new Date(),
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(contentTemplatesTable.id, id), eq(contentTemplatesTable.userId, userId)))
      .returning();
    if (!template) return null;
    const version = await recordTemplateVersion(tx, template, userId);
    await syncTemplateStorage(tx, template, version);
    return template;
  });
}

export async function getContentTemplateVersionsForUser(
  templateId: number,
  userId: number,
): Promise<ContentTemplateVersion[]> {
  const [template] = await db
    .select({ id: contentTemplatesTable.id, userId: contentTemplatesTable.userId })
    .from(contentTemplatesTable)
    .where(and(
      eq(contentTemplatesTable.id, templateId),
      or(eq(contentTemplatesTable.userId, userId), and(
        eq(contentTemplatesTable.isPredefined, true),
        eq(contentTemplatesTable.isApproved, true),
      )),
    ))
    .limit(1);
  if (!template) return [];
  return db
    .select()
    .from(contentTemplateVersionsTable)
    .where(and(
      eq(contentTemplateVersionsTable.templateId, templateId),
      // Sharing the current predefined template does not publish its old drafts.
      template.userId === userId ? undefined : eq(sql<string>`${contentTemplateVersionsTable.snapshot}->>'isApproved'`, 'true'),
    ))
    .orderBy(desc(contentTemplateVersionsTable.version));
}

// Delete a content template
export async function deleteContentTemplate(id: number): Promise<boolean> {
  return deleteTemplateStorage(id);
}

export async function deleteContentTemplateForUser(id: number, userId: number): Promise<boolean> {
  return deleteTemplateStorage(id, userId);
}

async function deleteTemplateStorage(id: number, userId?: number): Promise<boolean> {
  return db.transaction(async (tx: typeof db) => {
    const template = await lockTemplate(tx, id, userId);
    if (!template) return false;
    const versions: ContentTemplateVersion[] = await tx.select().from(contentTemplateVersionsTable)
      .where(eq(contentTemplateVersionsTable.templateId, id)).for('update');
    const deleted = await tx.delete(contentTemplatesTable).where(eq(contentTemplatesTable.id, id)).returning({ id: contentTemplatesTable.id });
    await releaseContentManagedStorage(tx, [contentStorageOwner('content_template', template),
      ...versions.map(version => contentStorageOwner('content_template_version', version))]);
    return deleted.length > 0;
  });
}

// Increment usage count
export async function incrementTemplateUsage(id: number): Promise<void> {
  await db
    .update(contentTemplatesTable)
    .set({
      usageCount: sql`${contentTemplatesTable.usageCount} + 1`,
      lastUsedAt: new Date()
    })
    .where(eq(contentTemplatesTable.id, id));
}

// Get most used templates
export async function getMostUsedTemplates(userId: number, limit: number = 10): Promise<ContentTemplate[]> {
  return await db
    .select()
    .from(contentTemplatesTable)
    .where(eq(contentTemplatesTable.userId, userId))
    .orderBy(desc(contentTemplatesTable.usageCount))
    .limit(limit);
}

// Duplicate a template
export async function duplicateContentTemplate(
  id: number,
  userId: number,
  importGovernance?: Pick<NewContentTemplate, 'brandToolkitId' | 'businessProfileId' | 'brandContextSnapshot'>,
): Promise<ContentTemplate | null> {
  const original = await getContentTemplateById(id);
  if (!original || (original.userId !== userId && !(original.isPredefined && original.isApproved))) return null;
  
  const { id: _id, createdAt: _created, updatedAt: _updated, usageCount: _usage, lastUsedAt: _lastUsed, ...templateData } = original;
  
  return await createContentTemplate({
    ...templateData,
    userId,
    brandToolkitId: original.isPredefined ? null : original.brandToolkitId,
    businessProfileId: original.isPredefined ? null : original.businessProfileId,
    brandContextSnapshot: original.isPredefined ? {} : original.brandContextSnapshot,
    ...importGovernance,
    name: `${original.name.slice(0, 248)} (Copy)`,
    usageCount: 0,
    lastUsedAt: null,
    isApproved: Boolean(importGovernance),
    approvedBy: importGovernance ? userId : null,
    approvedAt: importGovernance ? new Date() : null,
    isPredefined: false,
    version: 1,
  });
}

// Get all predefined templates (admin-created, shared with all users)
export async function getPredefinedTemplates(type?: string): Promise<ContentTemplate[]> {
  const conditions = [
    eq(contentTemplatesTable.isPredefined, true),
    eq(contentTemplatesTable.isApproved, true),
  ];
  if (type) {
    conditions.push(eq(contentTemplatesTable.type, type));
  }
  return await db
    .select()
    .from(contentTemplatesTable)
    .where(and(...conditions))
    .orderBy(desc(contentTemplatesTable.updatedAt))
    .limit(200);
}

