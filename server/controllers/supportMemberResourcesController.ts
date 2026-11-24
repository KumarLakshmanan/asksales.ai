import type { Request, Response } from 'express';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import {
  supportPlaybookAssignmentsTable,
  supportPlaybooksTable,
  supportPlaybookVersionsTable,
} from '../models/supportOrchestration/schema.js';
import { storageService } from '../services/StorageService.js';
import { withTenantSupportMediaTransaction } from '../services/supportMedia/SupportMediaTenantTransaction.js';
import { logger } from '../utils/logger.js';
import { contentDisposition } from '../utils/contentDisposition.js';
import { publishedMediaAssetAccess, publishedMediaGalleryAccess } from '../services/supportMedia/SupportMediaAccess.js';
import { MemberResourceScopeError, resolveSupportMemberResourceScope } from '../services/SupportMemberResourceScope.js';
import { resultRows as rows } from '../utils/queryRows.js';

type SupportMemberRequest = Request & { supportMember?: { id: number; userId: number; teamId: number } };

function ownerId(req: Request): number {
  return Number((req as SupportMemberRequest).supportMember?.userId || 0);
}

function positiveId(value: unknown): number {
  if (typeof value !== 'string' && typeof value !== 'number') return 0;
  if (typeof value === 'string' && !/^[1-9]\d*$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

async function memberMediaAccess(req: Request) {
  const member = (req as SupportMemberRequest).supportMember;
  if (!member || !positiveId(member.id) || !positiveId(member.userId) || !positiveId(member.teamId)) return null;
  const scope = await resolveSupportMemberResourceScope(member, req.query.ticketId);
  return {
    scope,
    context: { tenantId: member.userId, businessProfileId: scope.businessProfileId, audience: 'internal',
      channel: 'support_portal', purpose: 'internal_assist' } as const,
    membership: sql`EXISTS (
      SELECT 1 FROM team_members m JOIN support_teams t ON t.id = m.team_id AND t.user_id = m.user_id
      WHERE m.id = ${member.id} AND m.user_id = ${member.userId} AND m.team_id = ${member.teamId}
        AND m.is_active = TRUE AND t.is_active = TRUE
    )`,
  };
}

export async function listMemberMediaGalleries(req: Request, res: Response) {
  try {
    const access = await memberMediaAccess(req);
    if (!access) return res.status(401).json({ error: 'A valid support member is required.' });
    const galleries = await withTenantSupportMediaTransaction(access.context.tenantId, async (tx) => rows(await tx.execute(sql`
      SELECT g.id, g.title, g.description, g.entity_tags, g.allowed_channels, g.audience, g.business_profile_id,
        g.helpful_auto_attach, v.version_no, COUNT(a.id)::INTEGER AS asset_count
      FROM support_media_galleries g
      JOIN support_media_gallery_versions v ON v.id = g.current_published_version_id
      LEFT JOIN support_media_assets a ON ${publishedMediaAssetAccess(access.context)}
      WHERE ${publishedMediaGalleryAccess(access.context)} AND ${access.membership}
      GROUP BY g.id, v.id
      ORDER BY g.updated_at DESC, g.id DESC
    `)));
    return res.json({ galleries, resolvedScope: { ...access.scope, businessProfileId: access.context.businessProfileId,
      audience: access.context.audience, purpose: access.context.purpose, channel: access.context.channel } });
  } catch (error) {
    if (error instanceof MemberResourceScopeError) return res.status(error.status).json({ error: error.message });
    logger.error({ err: error }, '[SupportMemberResources] Failed to list media galleries');
    return res.status(500).json({ error: 'Unable to load the support media library.' });
  }
}

export async function getMemberMediaGallery(req: Request, res: Response) {
  try {
    const access = await memberMediaAccess(req);
    if (!access) return res.status(401).json({ error: 'A valid support member is required.' });
    const galleryId = positiveId(req.params.id);
    if (!galleryId) return res.status(404).json({ error: 'Published media gallery not found.' });
    const result = await withTenantSupportMediaTransaction(access.context.tenantId, async (tx) => rows(await tx.execute(sql`
      SELECT g.id, g.title, g.description, g.entity_tags, g.allowed_channels, g.audience, g.business_profile_id,
        g.helpful_auto_attach, v.version_no,
        COALESCE(jsonb_agg(jsonb_build_object(
          'id', a.id, 'name', a.name, 'owner_description', a.owner_description, 'alt_text', a.alt_text,
          'owner_tags', a.owner_tags, 'width', a.width, 'height', a.height,
          'mime_type', a.mime_type, 'sort_order', a.sort_order
        ) ORDER BY a.sort_order, a.id) FILTER (WHERE a.id IS NOT NULL), '[]'::jsonb) AS assets
      FROM support_media_galleries g
      JOIN support_media_gallery_versions v ON v.id = g.current_published_version_id
      LEFT JOIN support_media_assets a ON ${publishedMediaAssetAccess(access.context)}
      WHERE g.id = ${galleryId} AND ${publishedMediaGalleryAccess(access.context)} AND ${access.membership}
      GROUP BY g.id, v.id
    `))[0]);
    return result ? res.json(result) : res.status(404).json({ error: 'Published media gallery not found.' });
  } catch (error) {
    if (error instanceof MemberResourceScopeError) return res.status(error.status).json({ error: error.message });
    logger.error({ err: error }, '[SupportMemberResources] Failed to load media gallery');
    return res.status(500).json({ error: 'Unable to load the support media gallery.' });
  }
}

export async function downloadMemberMediaAsset(req: Request, res: Response) {
  try {
    const access = await memberMediaAccess(req);
    if (!access) return res.status(401).json({ error: 'A valid support member is required.' });
    const userId = access.context.tenantId;
    const assetId = positiveId(req.params.assetId);
    if (!assetId) return res.status(404).json({ error: 'Published media asset not found.' });
    const row = await withTenantSupportMediaTransaction(userId, async (tx) => rows(await tx.execute(sql`
      SELECT a.derivative_storage_file_id, a.mime_type, a.name
      FROM support_media_assets a
      JOIN support_media_galleries g ON g.id = a.gallery_id
      JOIN support_media_gallery_versions v ON v.id = a.gallery_version_id
      WHERE a.id = ${assetId} AND ${publishedMediaAssetAccess(access.context)} AND ${access.membership}
      LIMIT 1
    `))[0]);
    if (!row) return res.status(404).json({ error: 'Published media asset not found.' });
    const file = await storageService.downloadFile(Number(row.derivative_storage_file_id), userId);
    if (!file) return res.status(404).json({ error: 'Media bytes not found.' });
    res.setHeader('Content-Type', String(row.mime_type || 'image/jpeg'));
    res.setHeader('Content-Disposition', contentDisposition(`${String(row.name || 'support-media')}.jpg`));
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(file.buffer);
  } catch (error) {
    if (error instanceof MemberResourceScopeError) return res.status(error.status).json({ error: error.message });
    logger.error({ err: error }, '[SupportMemberResources] Failed to download media asset');
    return res.status(500).json({ error: 'Unable to load the support media asset.' });
  }
}

export async function listMemberPlaybooks(req: Request, res: Response) {
  try {
    const userId = ownerId(req);
    const playbooks = await db.select({
      id: supportPlaybooksTable.id,
      name: supportPlaybooksTable.name,
      description: supportPlaybooksTable.description,
      agentType: supportPlaybooksTable.agentType,
      activeVersion: supportPlaybooksTable.activeVersion,
      graph: supportPlaybookVersionsTable.graph,
      updatedAt: supportPlaybooksTable.updatedAt,
    }).from(supportPlaybooksTable)
      .innerJoin(supportPlaybookVersionsTable, and(
        eq(supportPlaybookVersionsTable.playbookId, supportPlaybooksTable.id),
        eq(supportPlaybookVersionsTable.version, supportPlaybooksTable.activeVersion),
      ))
      .where(and(
        eq(supportPlaybooksTable.userId, userId),
        eq(supportPlaybooksTable.status, 'published'),
        eq(supportPlaybooksTable.enabled, true),
      ))
      .orderBy(asc(supportPlaybooksTable.name));
    const assignments = playbooks.length
      ? await db.select().from(supportPlaybookAssignmentsTable).where(and(
          eq(supportPlaybookAssignmentsTable.userId, userId),
          eq(supportPlaybookAssignmentsTable.enabled, true),
        )).orderBy(asc(supportPlaybookAssignmentsTable.priority))
      : [];
    return res.json({
      playbooks: playbooks.map((playbook: (typeof playbooks)[number]) => ({
        ...playbook,
        assignments: assignments.filter((assignment: (typeof assignments)[number]) => assignment.playbookId === playbook.id),
      })),
    });
  } catch (error) {
    logger.error({ err: error }, '[SupportMemberResources] Failed to list playbooks');
    return res.status(500).json({ error: 'Unable to load support playbooks.' });
  }
}
