import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { currentBusinessScope, withSystemScope } from '../../tenancy/businessContext.js';
import { currentBillingScope } from '../../tenancy/billingContext.js';

export type OrganizationRole = 'owner' | 'billing_admin' | 'member';
export type BillingExecutor = { execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }> };
export interface BillingOrganization {
  id: number;
  name: string;
  ownerUserId: number;
  defaultForUserId: number | null;
  billingEligibilityAt: string | Date;
  role: OrganizationRole;
  canManageBilling: boolean;
  businessProfileId?: number | null;
}

export class BillingOrganizationError extends Error {
  constructor(message: string, public readonly status = 403, public readonly code = 'ORGANIZATION_FORBIDDEN') {
    super(message);
  }
}

function positiveId(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BillingOrganizationError('Invalid organization or account identifier.', 400, 'INVALID_ORGANIZATION');
  }
  return value;
}

function asOrganization(row: Record<string, unknown>): BillingOrganization {
  const role = row.role as OrganizationRole;
  return {
    id: Number(row.id), name: String(row.name), ownerUserId: Number(row.owner_user_id),
    defaultForUserId: row.default_for_user_id == null ? null : Number(row.default_for_user_id),
    billingEligibilityAt: row.billing_eligibility_at as string | Date,
    role, canManageBilling: role === 'owner' || role === 'billing_admin',
    businessProfileId: row.business_profile_id == null ? null : Number(row.business_profile_id),
  };
}

async function membership(userId: number, organizationId: number, executor: BillingExecutor): Promise<BillingOrganization> {
  positiveId(userId); positiveId(organizationId);
  const pinned = currentBillingScope();
  const business=currentBusinessScope() ?? (pinned?.businessProfileId && pinned.businessOwnerUserId ? {
    businessProfileId:pinned.businessProfileId,userId:pinned.businessOwnerUserId,actorUserId:pinned.actorUserId
  } : undefined);
  if(business) {
    if((business.actorUserId??business.userId)!==userId) throw new BillingOrganizationError('The billing actor does not match the selected business.');
    const result=await executor.execute(sql`SELECT o.*,p.id AS business_profile_id,
      COALESCE(NULLIF(trim(p.company_name),''),NULLIF(trim(p.business_name),''),p.name) AS name,
      CASE WHEN p.user_id=${userId} THEN 'owner' ELSE m.role END AS role,
      (p.user_id=o.owner_user_id) AS owner_account,
      EXISTS(SELECT 1 FROM billing_organization_memberships legacy WHERE legacy.organization_id=o.id
        AND legacy.user_id=${userId} AND legacy.status='active' AND legacy.role IN('owner','billing_admin')) AS legacy_billing_admin
      FROM company_settings p JOIN billing_organizations o ON o.id=p.billing_organization_id
      JOIN users u ON u.id=${userId} AND u.deleted_at IS NULL
      LEFT JOIN business_profile_memberships m ON m.business_profile_id=p.id AND m.user_id=${userId} AND m.status='active'
      WHERE p.id=${business.businessProfileId} AND p.user_id=${business.userId} AND o.id=${organizationId}
      AND (p.user_id=${userId} OR m.id IS NOT NULL) LIMIT 1`);
    const row=result.rows[0];
    if(!row)throw new BillingOrganizationError('This business profile is not available to your account.');
    const organization=asOrganization(row);
    organization.canManageBilling=organization.canManageBilling&&Boolean(row.owner_account||row.legacy_billing_admin);
    return organization;
  }
  const result = await executor.execute(sql`SELECT o.*,m.role FROM billing_organizations o
    JOIN billing_organization_memberships m ON m.organization_id=o.id
    JOIN users u ON u.id=m.user_id AND u.deleted_at IS NULL
    WHERE o.id=${organizationId} AND m.user_id=${userId} AND m.status='active' AND o.owner_user_id=${userId} LIMIT 1`);
  if (!result.rows[0]) throw new BillingOrganizationError('This billing organization is not available to your account.');
  return asOrganization(result.rows[0]);
}

/** Explicit scopes are authorized by actor membership. Ordinary resource calls
 * derive payment responsibility from the persisted business, never the actor's
 * personal wallet. userId remains the existing resource owner where applicable. */
export async function resolveBillingOrganization(userId: number, executor: BillingExecutor = db): Promise<number> {
  positiveId(userId);
  const billing = currentBillingScope();
  if (billing) {
    await membership(billing.actorUserId, billing.organizationId, executor);
    return billing.organizationId;
  }
  const business = currentBusinessScope();
  if (business) {
    if (business.userId !== userId && (business.actorUserId??business.userId)!==userId) throw new BillingOrganizationError('The billing account does not own the current business.');
    const result = await executor.execute(sql`SELECT billing_organization_id FROM company_settings
      WHERE id=${business.businessProfileId} AND user_id=${business.userId} LIMIT 1`);
    const id = Number(result.rows[0]?.billing_organization_id);
    if (!id) throw new BillingOrganizationError('The business billing organization is unavailable.', 409, 'BUSINESS_BILLING_UNAVAILABLE');
    await membership(business.actorUserId??business.userId, id, executor);
    return id;
  }
  const result = await executor.execute(sql`SELECT billing_default_organization(${userId}) AS id`);
  const id = Number(result.rows[0]?.id);
  if (!id) throw new BillingOrganizationError('The default billing organization is unavailable.', 503, 'BILLING_UNAVAILABLE');
  return id;
}

export async function getBillingOrganization(userId: number, organizationId?: number, executor: BillingExecutor = db): Promise<BillingOrganization> {
  return membership(userId, organizationId ?? await resolveBillingOrganization(userId, executor), executor);
}

export async function requireBillingRole(userId: number, organizationId?: number, executor: BillingExecutor = db): Promise<BillingOrganization> {
  const organization = await getBillingOrganization(userId, organizationId, executor);
  if (!organization.canManageBilling) throw new BillingOrganizationError('Ask an organization owner or billing admin to manage billing.', 403, 'BILLING_ROLE_REQUIRED');
  return organization;
}

async function requireOwner(userId: number, organizationId: number, executor: BillingExecutor) {
  const organization = await getBillingOrganization(userId, organizationId, executor);
  if (organization.role !== 'owner' || organization.ownerUserId !== userId) {
    throw new BillingOrganizationError('Only the organization owner can manage its members.', 403, 'ORGANIZATION_OWNER_REQUIRED');
  }
  return organization;
}

async function audit(executor: BillingExecutor, organizationId: number, userId: number, action: string, details: Record<string, unknown>) {
  await executor.execute(sql`INSERT INTO billing_organization_audit(organization_id,actor_user_id,action,details)
    VALUES(${organizationId},${userId},${action},${JSON.stringify(details)}::jsonb)`);
}

async function lockOrganization(executor: BillingExecutor, organizationId: number) {
  await executor.execute(sql`SELECT id FROM billing_organizations WHERE id=${positiveId(organizationId)} FOR UPDATE`);
}

function asMember(row: Record<string, unknown>) {
  return { id: Number(row.id), userId: row.user_id == null ? null : Number(row.user_id),
    email: String(row.email), role: row.role as OrganizationRole, status: String(row.status) };
}

export async function listBillingOrganizations(userId: number) {
  const organization=await getBillingOrganization(userId);
  return {
    organizations:[organization],invitations:[],selectedOrganizationId:organization.id,
  };
}

export async function inviteOrganizationMember(userId: number, organizationId: number, email: string, role: Exclude<OrganizationRole, 'owner'>) {
  const normalized = email.trim().toLowerCase();
  return db.transaction(async (tx: BillingExecutor) => {
    await lockOrganization(tx, organizationId);
    await requireOwner(userId, organizationId, tx);
    const existing = await tx.execute(sql`SELECT * FROM billing_organization_memberships
      WHERE organization_id=${organizationId} AND email=${normalized} FOR UPDATE`);
    if (existing.rows[0]?.status === 'active') throw new BillingOrganizationError('This person is already an active member.', 409, 'MEMBER_ALREADY_ACTIVE');
    const result = await tx.execute(sql`INSERT INTO billing_organization_memberships(organization_id,email,role,status,invited_by_user_id)
      VALUES(${organizationId},${normalized},${role},'invited',${userId}) ON CONFLICT(organization_id,email)
      DO UPDATE SET role=EXCLUDED.role,status='invited',invited_by_user_id=EXCLUDED.invited_by_user_id,updated_at=NOW() RETURNING *`);
    await audit(tx, organizationId, userId, 'member.invited', { membershipId: Number(result.rows[0].id), email: normalized, role });
    return { member: asMember(result.rows[0]) };
  });
}

export async function acceptOrganizationInvitation(userId: number, invitationId: number) {
  return db.transaction(async (tx: BillingExecutor) => {
    const invitation = await tx.execute(sql`SELECT organization_id FROM billing_organization_memberships
      WHERE id=${positiveId(invitationId)} AND status='invited'`);
    if (!invitation.rows[0]) throw new BillingOrganizationError('Invitation not found.', 404, 'INVITATION_NOT_FOUND');
    const organizationId = Number(invitation.rows[0].organization_id);
    await lockOrganization(tx, organizationId);
    const user = await tx.execute(sql`SELECT email,is_verified FROM users WHERE id=${positiveId(userId)} AND deleted_at IS NULL FOR KEY SHARE`);
    if (!user.rows[0]?.is_verified) throw new BillingOrganizationError('Verify your account email before accepting an organization invitation.', 403, 'VERIFIED_EMAIL_REQUIRED');
    const result = await tx.execute(sql`UPDATE billing_organization_memberships SET user_id=${userId},status='active',updated_at=NOW()
      WHERE id=${invitationId} AND status='invited' AND email=${String(user.rows[0].email).trim().toLowerCase()}
      AND (user_id IS NULL OR user_id=${userId}) RETURNING *`);
    if (!result.rows[0]) throw new BillingOrganizationError('This invitation does not belong to your account.', 403, 'INVITATION_FORBIDDEN');
    await audit(tx, organizationId, userId, 'member.accepted', { membershipId: invitationId });
    return { organization: await getBillingOrganization(userId, organizationId, tx) };
  });
}

export async function removeOrganizationMember(userId: number, organizationId: number, membershipId: number) {
  return db.transaction(async (tx: BillingExecutor) => {
    await lockOrganization(tx, organizationId);
    await requireOwner(userId, organizationId, tx);
    const found = await tx.execute(sql`SELECT user_id,role FROM billing_organization_memberships
      WHERE id=${positiveId(membershipId)} AND organization_id=${organizationId} AND status IN('active','invited') FOR UPDATE`);
    if (!found.rows[0] || found.rows[0].role === 'owner') throw new BillingOrganizationError('The organization owner cannot be removed.', 409, 'OWNER_REQUIRED');
    if (found.rows[0].user_id != null) {
      const owned = await tx.execute(sql`SELECT id FROM company_settings WHERE user_id=${Number(found.rows[0].user_id)} AND billing_organization_id=${organizationId}
        UNION ALL SELECT id FROM ai_visibility_workspaces WHERE owner_user_id=${Number(found.rows[0].user_id)} AND billing_organization_id=${organizationId} LIMIT 1`);
      if (owned.rows[0]) throw new BillingOrganizationError('Move this member’s businesses and workspaces to another organization before removing them.', 409, 'MEMBER_OWNS_RESOURCES');
    }
    await tx.execute(sql`UPDATE billing_organization_memberships SET status='revoked',updated_at=NOW() WHERE id=${membershipId}`);
    await audit(tx, organizationId, userId, 'member.revoked', { membershipId });
    return { success: true };
  });
}

/** Linked businesses and workspaces move as a connected component. Lock order:
 * billing organizations, owned businesses, owned workspaces, all by ID. This
 * keeps quota reservations and new project links serialized with the move. */
export async function assignBillingResources(userId: number, organizationId: number, resourceType: 'business' | 'workspace', resourceId: number) {
  positiveId(userId); positiveId(organizationId); positiveId(resourceId);
  await getBillingOrganization(userId, organizationId);
  return withSystemScope('Move authenticated owner resource billing assignments', () => db.transaction(async (tx: BillingExecutor) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(740301,${userId})`);
    await tx.execute(sql`SELECT id FROM billing_organizations WHERE id=${organizationId} OR id IN(
      SELECT billing_organization_id FROM company_settings WHERE user_id=${userId}
      UNION SELECT billing_organization_id FROM ai_visibility_workspaces WHERE owner_user_id=${userId}
    ) ORDER BY id FOR UPDATE`);
    await getBillingOrganization(userId, organizationId, tx);
    await tx.execute(sql`SELECT id FROM company_settings WHERE user_id=${userId} ORDER BY id FOR UPDATE`);
    await tx.execute(sql`SELECT id FROM ai_visibility_workspaces WHERE owner_user_id=${userId} ORDER BY id FOR UPDATE`);
    const graph = await tx.execute(sql`WITH RECURSIVE graph(kind,id) AS (
      VALUES(${resourceType}::text,${resourceId}::integer)
      UNION SELECT CASE WHEN g.kind='business' THEN 'workspace' ELSE 'business' END,
        CASE WHEN g.kind='business' THEN p.workspace_id ELSE p.business_profile_id END
      FROM graph g JOIN ai_visibility_projects p ON
        (g.kind='business' AND p.business_profile_id=g.id) OR (g.kind='workspace' AND p.workspace_id=g.id)
      WHERE p.business_profile_id IS NOT NULL
    ) SELECT g.kind,g.id,
      CASE WHEN g.kind='business' THEN b.user_id ELSE w.owner_user_id END AS owner_user_id,
      CASE WHEN g.kind='business' THEN b.billing_organization_id ELSE w.billing_organization_id END AS organization_id
    FROM graph g LEFT JOIN company_settings b ON g.kind='business' AND b.id=g.id
      LEFT JOIN ai_visibility_workspaces w ON g.kind='workspace' AND w.id=g.id ORDER BY g.kind,g.id`);
    if (graph.rows.some(row => Number(row.owner_user_id) !== userId)) {
      throw new BillingOrganizationError('You must own every linked business and workspace to move its billing.', 403, 'RESOURCE_OWNER_REQUIRED');
    }
    const businessIds = graph.rows.filter(row => row.kind === 'business').map(row => Number(row.id));
    const workspaceIds = graph.rows.filter(row => row.kind === 'workspace').map(row => Number(row.id));
    // Migration 302 provides aggregate quota checks; do not permit assignments
    // until these are installed, even when the destination currently has space.
    const usage = await tx.execute(sql`SELECT billing_usage_for_profiles(${sql.param(businessIds)}::integer[],${sql.param(workspaceIds)}::integer[],${organizationId}) AS usage`);
    for (const [resource, count] of Object.entries(usage.rows[0]?.usage as Record<string, number> || {})) {
      if (Number(count) > 0) await tx.execute(sql`SELECT billing_assert_capacity(${organizationId},${resource},${Number(count)}::bigint)`);
    }
    await tx.execute(sql`SELECT set_config('app.billing_assignment_actor',${String(userId)},true),
      set_config('app.billing_assignment_target',${String(organizationId)},true)`);
    if (businessIds.length) await tx.execute(sql`UPDATE company_settings SET billing_organization_id=${organizationId},updated_at=NOW()
      WHERE id=ANY(${sql.param(businessIds)}::integer[]) AND user_id=${userId} AND billing_organization_id<>${organizationId}`);
    if (workspaceIds.length) await tx.execute(sql`UPDATE ai_visibility_workspaces SET billing_organization_id=${organizationId},updated_at=NOW()
      WHERE id=ANY(${sql.param(workspaceIds)}::integer[]) AND owner_user_id=${userId} AND billing_organization_id<>${organizationId}`);
    const sourceOrganizationIds = [...new Set(graph.rows.map(row => Number(row.organization_id)))].filter(id => id !== organizationId);
    const details = { businessIds, workspaceIds, sourceOrganizationIds, destinationOrganizationId: organizationId };
    await audit(tx, organizationId, userId, 'resources.assigned', details);
    for (const source of sourceOrganizationIds) await audit(tx, source, userId, 'resources.released', details);
    return { success: true, organizationId, businessIds, workspaceIds };
  }));
}
