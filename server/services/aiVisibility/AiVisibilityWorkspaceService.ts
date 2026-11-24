import { requireBusinessScope } from '../../tenancy/businessContext.js';
import { resolveBusinessScope } from '../../tenancy/businessScopeResolver.js';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import {
  aiVisibilityAssetApprovalDecisionsTable,
  aiVisibilityAuditsTable,
  aiVisibilityGeneratedAssetLinksTable,
  aiVisibilityOrganizationsTable,
  aiVisibilityProjectsTable,
  aiVisibilityPromptRunsTable,
  aiVisibilityWorkspaceMembershipsTable,
  aiVisibilityWorkspacesTable,
  type AiVisibilityWhiteLabelDefaults,
  type AiVisibilityWorkspaceRole,
} from '../../models/aiVisibility/schema.js';
import { contentAssetsTable } from '../../models/contentAssets/schema.js';
import { usersTable } from '../../models/users/schema.js';

export type AiVisibilityWorkspaceCapability =
  | 'read'
  | 'edit'
  | 'manage_members'
  | 'manage_connections'
  | 'bill_wallet'
  | 'review_assets'
  | 'delete_project';

export interface AiVisibilityProjectAccess {
  actorUserId: number;
  ownerUserId: number;
  projectId: number;
  workspaceId: number;
  workspaceName: string;
  workspaceKind: 'private' | 'client';
  organizationId: number | null;
  role: AiVisibilityWorkspaceRole;
}

export class AiVisibilityWorkspaceAccessError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 403,
    public readonly code = 'AI_VISIBILITY_WORKSPACE_FORBIDDEN',
  ) {
    super(message);
  }
}

const CAPABILITIES: Record<
  AiVisibilityWorkspaceRole,
  ReadonlySet<AiVisibilityWorkspaceCapability>
> = {
  owner: new Set([
    'read',
    'edit',
    'manage_members',
    'manage_connections',
    'bill_wallet',
    'review_assets',
    'delete_project',
  ]),
  billing_admin: new Set(['read','edit','manage_connections','bill_wallet','review_assets','delete_project']),
  member: new Set(['read','edit','bill_wallet','review_assets']),
  agency_admin: new Set(['read', 'edit', 'manage_members', 'review_assets']),
  editor: new Set(['read', 'edit', 'review_assets']),
  client_reviewer: new Set(['read', 'review_assets']),
};

function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
  if (!normalized)
    throw new AiVisibilityWorkspaceAccessError(
      'Organization name must contain letters or numbers.',
      400,
      'INVALID_ORGANIZATION_NAME',
    );
  return normalized;
}

function normalizeWhiteLabelDefaults(
  value: AiVisibilityWhiteLabelDefaults | undefined,
): AiVisibilityWhiteLabelDefaults {
  if (!value) return {};
  const result: AiVisibilityWhiteLabelDefaults = {};
  const displayName = value.displayName?.trim();
  const tagline = value.tagline?.trim();
  if (displayName) result.displayName = displayName.slice(0, 255);
  if (tagline) result.tagline = tagline.slice(0, 500);
  if (value.primaryColor && /^#[0-9a-f]{6}$/i.test(value.primaryColor.trim()))
    result.primaryColor = value.primaryColor.trim().toLowerCase();
  if (value.accentColor && /^#[0-9a-f]{6}$/i.test(value.accentColor.trim()))
    result.accentColor = value.accentColor.trim().toLowerCase();
  return result;
}

export class AiVisibilityWorkspaceService {
  hasCapability(
    role: AiVisibilityWorkspaceRole,
    capability: AiVisibilityWorkspaceCapability,
  ): boolean {
    return CAPABILITIES[role].has(capability);
  }

  requireCapability(
    access: AiVisibilityProjectAccess,
    capability: AiVisibilityWorkspaceCapability,
  ): void {
    if (!this.hasCapability(access.role, capability)) {
      throw new AiVisibilityWorkspaceAccessError(
        `Your ${access.role.replace('_', ' ')} role cannot perform this action.`,
      );
    }
  }

  private async profileAccess(actorUserId: number) {
    const current = requireBusinessScope();
    if ((current.actorUserId ?? current.userId) !== actorUserId) throw new AiVisibilityWorkspaceAccessError('Business actor mismatch.');
    const scope = await resolveBusinessScope(actorUserId, current.businessProfileId);
    if (!scope || scope.userId !== current.userId) throw new AiVisibilityWorkspaceAccessError('Business staff access is unavailable.');
    const result = await db.execute(sql`SELECT COALESCE(NULLIF(company_name,''),NULLIF(business_name,''),name) AS name
      FROM company_settings WHERE id=${scope.businessProfileId} AND user_id=${scope.userId}`);
    return {...scope,name:String(result.rows[0]?.name || 'Business profile')};
  }

  async projectAccess(actorUserId: number, projectId: number): Promise<AiVisibilityProjectAccess> {
    const profile = await this.profileAccess(actorUserId);
    const [project] = await db.select().from(aiVisibilityProjectsTable).where(and(
      eq(aiVisibilityProjectsTable.id,projectId),eq(aiVisibilityProjectsTable.userId,profile.userId),
      eq(aiVisibilityProjectsTable.businessProfileId,profile.businessProfileId),eq(aiVisibilityProjectsTable.status,'active'))).limit(1);
    if (!project) throw new AiVisibilityWorkspaceAccessError('AI Visibility website not found.',404,'AI_VISIBILITY_PROJECT_NOT_FOUND');
    return {actorUserId,ownerUserId:profile.userId,projectId:project.id,workspaceId:project.workspaceId,
      workspaceName:profile.name,workspaceKind:'private',organizationId:null,role:profile.role ?? 'owner'};
  }

  async auditAccess(actorUserId: number, auditId: number): Promise<AiVisibilityProjectAccess> {
    const [audit] = await db
      .select({ projectId: aiVisibilityAuditsTable.projectId })
      .from(aiVisibilityAuditsTable)
      .where(eq(aiVisibilityAuditsTable.id, auditId))
      .limit(1);
    if (!audit)
      throw new AiVisibilityWorkspaceAccessError(
        'AI Visibility audit not found.',
        404,
        'AI_VISIBILITY_AUDIT_NOT_FOUND',
      );
    return this.projectAccess(actorUserId, audit.projectId);
  }

  async promptRunAccess(
    actorUserId: number,
    promptRunId: number,
  ): Promise<AiVisibilityProjectAccess> {
    const [run] = await db
      .select({ projectId: aiVisibilityAuditsTable.projectId })
      .from(aiVisibilityPromptRunsTable)
      .innerJoin(
        aiVisibilityAuditsTable,
        eq(aiVisibilityAuditsTable.id, aiVisibilityPromptRunsTable.auditId),
      )
      .where(eq(aiVisibilityPromptRunsTable.id, promptRunId))
      .limit(1);
    if (!run)
      throw new AiVisibilityWorkspaceAccessError(
        'AI Visibility prompt observation not found.',
        404,
        'AI_VISIBILITY_PROMPT_RUN_NOT_FOUND',
      );
    return this.projectAccess(actorUserId, run.projectId);
  }

  async listAccessibleProjects(actorUserId: number) {
    const profile = await this.profileAccess(actorUserId);
    const projects = await db.select().from(aiVisibilityProjectsTable).where(and(
      eq(aiVisibilityProjectsTable.businessProfileId,profile.businessProfileId),
      eq(aiVisibilityProjectsTable.userId,profile.userId),eq(aiVisibilityProjectsTable.status,'active')))
      .orderBy(desc(aiVisibilityProjectsTable.updatedAt));
    return projects.map((project: typeof aiVisibilityProjectsTable.$inferSelect) => ({...project,workspace:{
      workspaceName:profile.name,workspaceKind:'private',organizationId:null,role:profile.role ?? 'owner'}}));
  }

  async listWorkspaces(actorUserId: number) {
    const profile = await this.profileAccess(actorUserId);
    const workspaces = await db.select().from(aiVisibilityWorkspacesTable).where(and(
      eq(aiVisibilityWorkspacesTable.businessProfileId,profile.businessProfileId),
      eq(aiVisibilityWorkspacesTable.ownerUserId,profile.userId),eq(aiVisibilityWorkspacesTable.status,'active')));
    return workspaces.map((workspace: typeof aiVisibilityWorkspacesTable.$inferSelect) => ({
      workspace:{...workspace,name:profile.name},organization:null,
      membership:{role:profile.role ?? 'owner',userId:actorUserId},members:[]}));
  }

  async createOrganization(
    actorUserId: number,
    input: {
      name: string;
      whiteLabelDefaults?: AiVisibilityWhiteLabelDefaults;
    },
  ) {
    const name = input.name.trim();
    if (!name)
      throw new AiVisibilityWorkspaceAccessError(
        'Organization name is required.',
        400,
        'INVALID_ORGANIZATION_NAME',
      );
    const baseSlug = slugify(name);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const slug = attempt ? `${baseSlug}-${attempt + 1}` : baseSlug;
      try {
        const [organization] = await db
          .insert(aiVisibilityOrganizationsTable)
          .values({
            ownerUserId: actorUserId,
            name: name.slice(0, 255),
            slug,
            whiteLabelDefaults: normalizeWhiteLabelDefaults(input.whiteLabelDefaults),
          })
          .returning();
        return organization;
      } catch (error) {
        if ((error as { code?: string })?.code !== '23505') throw error;
      }
    }
    throw new AiVisibilityWorkspaceAccessError(
      'Could not create a unique organization slug.',
      409,
      'ORGANIZATION_SLUG_CONFLICT',
    );
  }

  async updateOrganization(
    actorUserId: number,
    organizationId: number,
    input: {
      name?: string;
      whiteLabelDefaults?: AiVisibilityWhiteLabelDefaults;
    },
  ) {
    const [organization] = await db
      .select()
      .from(aiVisibilityOrganizationsTable)
      .where(
        and(
          eq(aiVisibilityOrganizationsTable.id, organizationId),
          eq(aiVisibilityOrganizationsTable.ownerUserId, actorUserId),
          eq(aiVisibilityOrganizationsTable.status, 'active'),
        ),
      )
      .limit(1);
    if (!organization)
      throw new AiVisibilityWorkspaceAccessError(
        'Organization not found.',
        404,
        'AI_VISIBILITY_ORGANIZATION_NOT_FOUND',
      );
    const [updated] = await db
      .update(aiVisibilityOrganizationsTable)
      .set({
        ...(input.name !== undefined ? { name: input.name.trim().slice(0, 255) } : {}),
        ...(input.whiteLabelDefaults !== undefined
          ? {
              whiteLabelDefaults: normalizeWhiteLabelDefaults(input.whiteLabelDefaults),
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(aiVisibilityOrganizationsTable.id, organizationId))
      .returning();
    return updated;
  }

  async updateWorkspace(
    actorUserId: number,
    workspaceId: number,
    input: {
      name?: string;
      organizationId?: number | null;
      kind?: 'private' | 'client';
      whiteLabelDefaults?: AiVisibilityWhiteLabelDefaults;
    },
  ) {
    const access = await this.workspaceAccess(actorUserId, workspaceId);
    this.requireCapability(access, 'edit');
    if (input.name !== undefined || input.organizationId !== undefined || input.kind !== undefined) {
      throw new AiVisibilityWorkspaceAccessError('Manage workspace identity in Business profile settings.',410,'BUSINESS_PROFILE_IS_WORKSPACE');
    }
    const [workspace] = await db
      .update(aiVisibilityWorkspacesTable)
      .set({
        ...(input.whiteLabelDefaults !== undefined
          ? {
              whiteLabelDefaults: normalizeWhiteLabelDefaults(input.whiteLabelDefaults),
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(aiVisibilityWorkspacesTable.id, workspaceId))
      .returning();
    return workspace;
  }

  async addMember(
    actorUserId: number,
    workspaceId: number,
    input: { email: string; role: Exclude<AiVisibilityWorkspaceRole, 'owner'> },
  ) {
    const access = await this.workspaceAccess(actorUserId, workspaceId);
    this.requireCapability(access, 'manage_members');
    if (access.role === 'agency_admin' && input.role === 'agency_admin') {
      throw new AiVisibilityWorkspaceAccessError(
        'Only the owner can appoint another agency admin.',
      );
    }
    const email = input.email.trim().toLowerCase();
    const [user] = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        name: usersTable.name,
      })
      .from(usersTable)
      .where(and(eq(usersTable.email, email), eq(usersTable.isApproved, true)))
      .limit(1);
    if (!user)
      throw new AiVisibilityWorkspaceAccessError(
        'Invitee must already have an approved account.',
        404,
        'AI_VISIBILITY_MEMBER_NOT_FOUND',
      );
    if (user.id === access.ownerUserId)
      throw new AiVisibilityWorkspaceAccessError(
        'The workspace owner already has access.',
        409,
        'AI_VISIBILITY_MEMBER_EXISTS',
      );
    const [membership] = await db
      .insert(aiVisibilityWorkspaceMembershipsTable)
      .values({
        workspaceId,
        userId: user.id,
        role: input.role,
        status: 'active',
        invitedByUserId: actorUserId,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          aiVisibilityWorkspaceMembershipsTable.workspaceId,
          aiVisibilityWorkspaceMembershipsTable.userId,
        ],
        set: {
          role: input.role,
          status: 'active',
          invitedByUserId: actorUserId,
          updatedAt: new Date(),
        },
      })
      .returning();
    return { ...membership, email: user.email, name: user.name };
  }

  async updateMember(
    actorUserId: number,
    workspaceId: number,
    membershipId: number,
    input: {
      role?: Exclude<AiVisibilityWorkspaceRole, 'owner'>;
      status?: 'active' | 'revoked';
    },
  ) {
    const access = await this.workspaceAccess(actorUserId, workspaceId);
    this.requireCapability(access, 'manage_members');
    const [existing] = await db
      .select()
      .from(aiVisibilityWorkspaceMembershipsTable)
      .where(
        and(
          eq(aiVisibilityWorkspaceMembershipsTable.id, membershipId),
          eq(aiVisibilityWorkspaceMembershipsTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!existing)
      throw new AiVisibilityWorkspaceAccessError(
        'Workspace member not found.',
        404,
        'AI_VISIBILITY_MEMBER_NOT_FOUND',
      );
    if (existing.role === 'owner')
      throw new AiVisibilityWorkspaceAccessError(
        'The workspace owner cannot be changed or revoked.',
      );
    if (
      access.role === 'agency_admin' &&
      (existing.role === 'agency_admin' || input.role === 'agency_admin')
    ) {
      throw new AiVisibilityWorkspaceAccessError('Only the owner can manage agency admins.');
    }
    const [membership] = await db
      .update(aiVisibilityWorkspaceMembershipsTable)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(aiVisibilityWorkspaceMembershipsTable.id, membershipId))
      .returning();
    return membership;
  }

  async decideAsset(
    actorUserId: number,
    projectId: number,
    generatedAssetLinkId: number,
    input: {
      decision: 'approved' | 'rejected';
      comment?: string | null;
      assetVersion: number;
    },
  ) {
    const access = await this.projectAccess(actorUserId, projectId);
    this.requireCapability(access, 'review_assets');
    return db.transaction(async (tx: typeof db) => {
      const [record] = await tx
        .select({
          link: aiVisibilityGeneratedAssetLinksTable,
          asset: contentAssetsTable,
        })
        .from(aiVisibilityGeneratedAssetLinksTable)
        .innerJoin(
          contentAssetsTable,
          eq(contentAssetsTable.id, aiVisibilityGeneratedAssetLinksTable.contentAssetId),
        )
        .where(
          and(
            eq(aiVisibilityGeneratedAssetLinksTable.id, generatedAssetLinkId),
            eq(aiVisibilityGeneratedAssetLinksTable.projectId, projectId),
            eq(contentAssetsTable.version, input.assetVersion),
            eq(contentAssetsTable.userId, access.ownerUserId),
          ),
        )
        .limit(1)
        .for('update');
      if (!record)
        throw new AiVisibilityWorkspaceAccessError(
          'Generated asset version not found.',
          404,
          'AI_VISIBILITY_ASSET_NOT_FOUND',
        );
      const [asset] = await tx
        .update(contentAssetsTable)
        .set({
          approvalStatus: input.decision,
          approvedBy: input.decision === 'approved' ? actorUserId : null,
          approvedAt: input.decision === 'approved' ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(contentAssetsTable.id, record.asset.id),
            eq(contentAssetsTable.version, input.assetVersion),
          ),
        )
        .returning();
      if (!asset)
        throw new AiVisibilityWorkspaceAccessError(
          'The asset changed during review. Reload the latest version.',
          409,
          'AI_VISIBILITY_ASSET_CHANGED',
        );
      const [decision] = await tx
        .insert(aiVisibilityAssetApprovalDecisionsTable)
        .values({
          workspaceId: access.workspaceId,
          projectId,
          generatedAssetLinkId,
          contentAssetId: record.asset.id,
          assetVersion: input.assetVersion,
          actorUserId,
          decision: input.decision,
          comment: input.comment?.trim().slice(0, 2000) || null,
        })
        .returning();
      return { asset, decision };
    });
  }

  async approvalHistory(actorUserId: number, projectId: number) {
    const access = await this.projectAccess(actorUserId, projectId);
    this.requireCapability(access, 'read');
    return db
      .select({
        decision: aiVisibilityAssetApprovalDecisionsTable,
        actorName: usersTable.name,
        actorEmail: usersTable.email,
      })
      .from(aiVisibilityAssetApprovalDecisionsTable)
      .innerJoin(usersTable, eq(usersTable.id, aiVisibilityAssetApprovalDecisionsTable.actorUserId))
      .where(eq(aiVisibilityAssetApprovalDecisionsTable.projectId, projectId))
      .orderBy(desc(aiVisibilityAssetApprovalDecisionsTable.createdAt));
  }

  private async workspaceAccess(actorUserId: number, workspaceId: number): Promise<AiVisibilityProjectAccess> {
    const profile = await this.profileAccess(actorUserId);
    const [workspace] = await db.select().from(aiVisibilityWorkspacesTable).where(and(
      eq(aiVisibilityWorkspacesTable.id,workspaceId),eq(aiVisibilityWorkspacesTable.businessProfileId,profile.businessProfileId),
      eq(aiVisibilityWorkspacesTable.ownerUserId,profile.userId),eq(aiVisibilityWorkspacesTable.status,'active'))).limit(1);
    if (!workspace) throw new AiVisibilityWorkspaceAccessError('AI Visibility workspace not found.',404,'AI_VISIBILITY_WORKSPACE_NOT_FOUND');
    return {actorUserId,ownerUserId:profile.userId,projectId:0,workspaceId,workspaceName:profile.name,
      workspaceKind:'private',organizationId:null,role:profile.role ?? 'owner'};
  }

}

export const aiVisibilityWorkspaceService = new AiVisibilityWorkspaceService();
