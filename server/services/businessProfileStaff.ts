import { sql, getTableColumns } from "drizzle-orm";
import { db } from "../models/db.js";
import { companySettings } from "../models/companySettings/schema.js";
import { resolveBusinessScope } from "../tenancy/businessScopeResolver.js";
import { withSystemScope } from "../tenancy/businessContext.js";
import type { BusinessRole } from "../tenancy/businessContext.js";
import type { BillingExecutor } from "./billing/organizations.js";

export class BusinessProfileAccessError extends Error {
  constructor(
    message: string,
    public readonly status = 403,
    public readonly code = "BUSINESS_PROFILE_FORBIDDEN",
  ) {
    super(message);
  }
}

export type AccessibleBusinessProfile = typeof companySettings.$inferSelect & {
  role: BusinessRole;
  ownerApproved: boolean;
  brandToolkitCompleted:boolean;
  canManageTeam: boolean;
  canManageBilling: boolean;
};
export async function accessibleBusinessProfiles(
  userId: number,
  profileId?: number,
  includeArchived = false,
): Promise<AccessibleBusinessProfile[]> {
  const profiles = await withSystemScope("Read setup status for explicitly accessible business profiles",()=>db
    .select({
      ...getTableColumns(companySettings),
      brandToolkitCompleted: sql<boolean>`EXISTS(SELECT 1 FROM brand_toolkits toolkit WHERE toolkit.business_profile_id=company_settings.id AND toolkit.user_id=company_settings.user_id AND toolkit.is_active=true)`,
      ownerApproved: sql<boolean>`(SELECT is_approved FROM users WHERE id=company_settings.user_id)`,
      role: sql<BusinessRole>`CASE WHEN company_settings.user_id=${userId} THEN 'owner' ELSE
      (SELECT m.role FROM business_profile_memberships m WHERE m.business_profile_id=company_settings.id AND m.user_id=${userId} AND m.status='active') END`,
      isDefault: sql<boolean>`COALESCE((SELECT pref.default_business_profile_id=company_settings.id FROM business_profile_preferences pref
      WHERE pref.user_id=${userId} AND pref.default_business_profile_id IS NOT NULL),company_settings.user_id=${userId} AND company_settings.is_default)`,
    })
    .from(companySettings)
    .where(
      sql`
    ${includeArchived ? sql`` : sql`company_settings.archived_at IS NULL AND`}
    EXISTS(SELECT 1 FROM users owner WHERE owner.id=company_settings.user_id AND owner.deleted_at IS NULL)
    AND (company_settings.user_id=${userId} OR EXISTS(SELECT 1 FROM business_profile_memberships m
      WHERE m.business_profile_id=company_settings.id AND m.user_id=${userId} AND m.status='active'))
    ${profileId === undefined ? sql`` : sql`AND company_settings.id=${profileId}`}
  `,
    )
    .orderBy(sql`company_settings.id`));
  return profiles
    .map(
      (
        profile: typeof companySettings.$inferSelect & {
          role: BusinessRole;
          isDefault: boolean;
          ownerApproved: boolean;
          brandToolkitCompleted:boolean;
        },
      ) => ({
        ...profile,
        canManageTeam: profile.role === "owner",
        canManageBilling:
          profile.role === "owner" || profile.role === "billing_admin",
      }),
    )
    .sort(
      (a: { isDefault: boolean }, b: { isDefault: boolean }) =>
        Number(b.isDefault) - Number(a.isDefault),
    );
}

export async function requireBusinessAccess(
  userId: number,
  profileId: number,
  ownerOnly = false,
) {
  const scope = await resolveBusinessScope(userId, profileId);
  if (!scope)
    throw new BusinessProfileAccessError(
      "This business profile is not available to your account.",
    );
  if (ownerOnly && scope.userId !== userId)
    throw new BusinessProfileAccessError(
      "Only the business owner can manage this setting.",
      403,
      "BUSINESS_OWNER_REQUIRED",
    );
  return scope;
}

const member = (r: Record<string, unknown>) => ({
  id: Number(r.id),
  userId: r.user_id == null ? null : Number(r.user_id),
  email: String(r.email),
  role: r.role as BusinessRole,
  status: String(r.status),
});

async function audit(
  tx: BillingExecutor,
  profileId: number,
  actorId: number,
  action: string,
  details: Record<string, unknown>,
) {
  await tx.execute(sql`INSERT INTO business_profile_membership_audit(business_profile_id,actor_user_id,action,details)
    VALUES(${profileId},${actorId},${action},${JSON.stringify(details)}::jsonb)`);
}

export async function listBusinessStaff(userId: number, profileId: number) {
  await requireBusinessAccess(userId, profileId);
  const result =
    await db.execute(sql`SELECT id,user_id,email,role,status FROM business_profile_memberships
    WHERE business_profile_id=${profileId} AND status IN('active','invited') ORDER BY role='owner' DESC,id`);
  return { members: result.rows.map(member) };
}

export async function inviteBusinessStaff(
  userId: number,
  profileId: number,
  email: string,
  role: "billing_admin" | "member",
) {
  await requireBusinessAccess(userId, profileId, true);
  const normalized = email.trim().toLowerCase();
  return db.transaction(async (tx: BillingExecutor) => {
    await tx.execute(
      sql`SELECT id FROM company_settings WHERE id=${profileId} AND user_id=${userId} FOR UPDATE`,
    );
    const existing =
      await tx.execute(sql`SELECT id,role,status FROM business_profile_memberships
      WHERE business_profile_id=${profileId} AND email=${normalized} FOR UPDATE`);
    if (
      existing.rows[0]?.role === "owner" ||
      existing.rows[0]?.status === "active"
    )
      throw new BusinessProfileAccessError(
        "This person is already a member of this business.",
        409,
        "MEMBER_ALREADY_ACTIVE",
      );
    const result =
      await tx.execute(sql`INSERT INTO business_profile_memberships(business_profile_id,email,role,status,invited_by_user_id)
      VALUES(${profileId},${normalized},${role},'invited',${userId}) ON CONFLICT(business_profile_id,email)
      DO UPDATE SET user_id=NULL,role=EXCLUDED.role,status='invited',invited_by_user_id=EXCLUDED.invited_by_user_id,updated_at=now() RETURNING *`);
    await audit(tx, profileId, userId, "staff.invited", {
      membershipId: Number(result.rows[0].id),
      email: normalized,
      role,
    });
    return { member: member(result.rows[0]) };
  });
}

export async function listBusinessInvitations(userId: number) {
  const result =
    await db.execute(sql`SELECT m.id,m.business_profile_id,m.email,m.role,
    COALESCE(NULLIF(trim(p.company_name),''),NULLIF(trim(p.business_name),''),p.name) AS business_profile_name
    FROM business_profile_memberships m JOIN company_settings p ON p.id=m.business_profile_id
    JOIN users owner ON owner.id=p.user_id AND owner.deleted_at IS NULL
    JOIN users u ON u.id=${userId} AND lower(trim(u.email))=m.email AND u.deleted_at IS NULL
    WHERE m.status='invited' AND p.archived_at IS NULL ORDER BY m.created_at DESC`);
  return {
    invitations: result.rows.map((r: Record<string, unknown>) => ({
      id: Number(r.id),
      businessProfileId: Number(r.business_profile_id),
      businessProfileName: String(r.business_profile_name),
      email: String(r.email),
      role: r.role,
    })),
  };
}

export async function acceptBusinessInvitation(
  userId: number,
  invitationId: number,
) {
  const profileId = await db.transaction(async (tx: BillingExecutor) => {
    const target = await tx.execute(
      sql`SELECT business_profile_id FROM business_profile_memberships WHERE id=${invitationId}`,
    );
    if (!target.rows[0])
      throw new BusinessProfileAccessError(
        "Invitation not found.",
        404,
        "INVITATION_NOT_FOUND",
      );
    // Match owner mutations' profile -> membership -> payer lock order.
    const available = await tx.execute(
      sql`SELECT p.id FROM company_settings p JOIN users owner ON owner.id=p.user_id
        WHERE p.id=${Number(target.rows[0].business_profile_id)} AND p.archived_at IS NULL
          AND owner.deleted_at IS NULL FOR UPDATE OF p`,
    );
    if (!available.rows[0]) throw new BusinessProfileAccessError(
      'This business is unavailable. Ask its owner to restore it before joining.',
      409, 'BUSINESS_PROFILE_UNAVAILABLE',
    );

    const found =
      await tx.execute(sql`SELECT m.*,u.is_verified FROM business_profile_memberships m
      JOIN users u ON u.id=${userId} AND u.deleted_at IS NULL AND lower(trim(u.email))=m.email
      WHERE m.id=${invitationId} AND m.status IN('active','invited') FOR UPDATE OF m`);
    const invitation = found.rows[0];
    if (
      !invitation ||
      (invitation.user_id != null && Number(invitation.user_id) !== userId)
    )
      throw new BusinessProfileAccessError(
        "This invitation is not available to your account.",
        404,
        "INVITATION_NOT_FOUND",
      );
    if (!invitation.is_verified)
      throw new BusinessProfileAccessError(
        "Verify your email before accepting this invitation.",
        403,
        "VERIFIED_EMAIL_REQUIRED",
      );
    const id = Number(invitation.business_profile_id);
    if (invitation.status !== "active") {
      await tx.execute(
        sql`UPDATE business_profile_memberships SET user_id=${userId},status='active',updated_at=now() WHERE id=${invitationId}`,
      );
      await audit(tx, id, userId, "staff.accepted", {
        membershipId: invitationId,
      });
    }
    await tx.execute(sql`INSERT INTO business_profile_preferences(user_id,default_business_profile_id) VALUES(${userId},${id})
      ON CONFLICT(user_id) DO UPDATE SET default_business_profile_id=EXCLUDED.default_business_profile_id`);
    return id;
  });
  const businessProfile = (await accessibleBusinessProfiles(userId, profileId))[0];
  if (!businessProfile) throw new BusinessProfileAccessError(
    'The business became unavailable. Refresh your invitations and ask its owner for help.',
    409, 'BUSINESS_PROFILE_UNAVAILABLE',
  );
  return { businessProfile };
}

export async function changeBusinessStaff(
  userId: number,
  profileId: number,
  membershipId: number,
  role?: "billing_admin" | "member",
) {
  await requireBusinessAccess(userId, profileId, true);
  return db.transaction(async (tx: BillingExecutor) => {
    await tx.execute(
      sql`SELECT id FROM company_settings WHERE id=${profileId} AND user_id=${userId} FOR UPDATE`,
    );
    const result = await tx.execute(
      role === undefined
        ? sql`UPDATE business_profile_memberships SET status='revoked',updated_at=now() WHERE id=${membershipId} AND business_profile_id=${profileId} AND role<>'owner' RETURNING *`
        : sql`UPDATE business_profile_memberships SET role=${role},updated_at=now() WHERE id=${membershipId} AND business_profile_id=${profileId} AND role<>'owner' AND status IN('active','invited') RETURNING *`,
    );
    if (!result.rows[0])
      throw new BusinessProfileAccessError(
        "Staff membership not found or belongs to the owner.",
        404,
        "MEMBERSHIP_NOT_FOUND",
      );
    // A removed/demoted manager may have copied webhook capabilities. Rotate
    // the account nonce in the same transaction as the authority change.
    await tx.execute(sql`UPDATE users SET webhook_token_nonce=replace(gen_random_uuid()::text,'-','') ||
      replace(gen_random_uuid()::text,'-',''),updated_at=NOW() WHERE id=${userId}`);
    await tx.execute(sql`UPDATE channel_credentials SET legacy_webhook_token_hash=NULL,updated_at=NOW()
      WHERE user_id=${userId} AND platform='whatsapp' AND legacy_webhook_token_hash IS NOT NULL`);
    await audit(
      tx,
      profileId,
      userId,
      role === undefined ? "staff.revoked" : "staff.role_changed",
      { membershipId, ...(role ? { role } : {}) },
    );
    return { member: member(result.rows[0]) };
  });
}

export async function setBusinessPreference(userId: number, profileId: number) {
  await requireBusinessAccess(userId, profileId);
  await db.execute(sql`INSERT INTO business_profile_preferences(user_id,default_business_profile_id) VALUES(${userId},${profileId})
    ON CONFLICT(user_id) DO UPDATE SET default_business_profile_id=EXCLUDED.default_business_profile_id`);
  return (await accessibleBusinessProfiles(userId, profileId))[0];
}
