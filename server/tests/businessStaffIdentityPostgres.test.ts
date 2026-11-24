import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { createBusinessScopedPool } from "../tenancy/scopedPool.js";
import {
  withBusinessScope,
  withSystemScope,
  currentBusinessScope,
  businessOwnerUserId,
} from "../tenancy/businessContext.js";
import { withBillingScope } from "../tenancy/billingContext.js";
import { assertBusinessScopeSchema } from "../tenancy/schemaGuard.js";
import type { Request, Response } from "express";
const database = process.env.BUSINESS_STAFF_TEST_DATABASE;
let appDb: ReturnType<typeof drizzle>;
jest.unstable_mockModule("../models/db.js", () => ({
  db: new Proxy(
    {},
    {
      get(_t, key) {
        const v = Reflect.get(appDb, key);
        return typeof v === "function" ? v.bind(appDb) : v;
      },
    },
  ),
}));
jest.unstable_mockModule("../services/dashboardCache.js", () => ({
  invalidateDashboardCache: jest.fn(),
}));
const { creditService } = await import("../services/CreditService.js");
const { getOrCreateWallet, getBalance } =
  await import("../models/wallets/functions.js");
const staff = await import("../services/businessProfileStaff.js");
const billing = await import("../services/billing/organizations.js");
const { resolveBusinessScope } =
  await import("../tenancy/businessScopeResolver.js");
const { captureJobBusiness, runBusinessJob } =
  await import("../tenancy/jobBusinessScope.js");
const { businessProfileScope } =
  await import("../middleware/businessProfileScope.js");
const { billingOrganizationScope } =
  await import("../middleware/billingOrganizationScope.js");
const { businessPermissions } =
  await import("../middleware/businessPermissions.js");
const { aiVisibilityWorkspaceService: ai } =
  await import("../services/aiVisibility/AiVisibilityWorkspaceService.js");
(database ? describe : describe.skip)(
  "canonical staff identity with real PostgreSQL",
  () => {
    let admin: Pool,
      pool: Pool,
      owner: number,
      member: number,
      stranger: number,
      north: number,
      south: number,
      payer: number,
      memberPayer: number;
    let deductionId: number;
    let membership: number,
      northThread: number,
      southThread: number,
      projectId: number,
      workspaceId: number;
    let captured: Awaited<ReturnType<typeof captureJobBusiness>>;
    const asBusiness = <T>(actor: number, profile: number, work: () => T) =>
      withBusinessScope(
        {
          userId: owner,
          actorUserId: actor,
          businessProfileId: profile,
          role: actor === owner ? "owner" : "member",
        },
        work,
      );
    const response = () => {
      const r = { status: jest.fn(), json: jest.fn() };
      r.status.mockReturnValue(r);
      return r as unknown as Response;
    };
    beforeAll(async () => {
      if (!database?.startsWith("asksales_profile_identity_"))
        throw new Error(
          "Use an explicitly selected disposable local QA database.",
        );
      admin = new Pool({ host: "/tmp", database, max: 2 });
      pool = createBusinessScopedPool(
        new Pool({ host: "/tmp", database, max: 6 }),
      );
      appDb = drizzle(pool);
      await assertBusinessScopeSchema(admin);
      const suffix = randomUUID();
      const users = await admin.query(
        "INSERT INTO users(email,password,name,is_verified,is_approved) VALUES($1,'fixture','Owner',true,true),($2,'fixture','Staff',true,false),($3,'fixture','Stranger',true,true) RETURNING id",
        [
          `owner-${suffix}@example.invalid`,
          `staff-${suffix}@example.invalid`,
          `stranger-${suffix}@example.invalid`,
        ],
      );
      [owner, member, stranger] = users.rows.map((r) => r.id);
      const profiles = await admin.query(
        "INSERT INTO company_settings(user_id,name,company_name,is_default,is_approved) VALUES($1,'North','North',true,true),($1,'South','South',false,true) RETURNING id,billing_organization_id",
        [owner],
      );
      [north, south] = profiles.rows.map((r) => r.id);
      payer = profiles.rows[0].billing_organization_id;
      memberPayer = Number(
        (
          await admin.query("SELECT billing_default_organization($1) AS id", [
            member,
          ])
        ).rows[0].id,
      );
      northThread = await asBusiness(owner, north, async () =>
        Number(
          (
            await pool.query(
              "INSERT INTO chat_threads(user_id,title) VALUES($1,'North fixture') RETURNING id",
              [owner],
            )
          ).rows[0].id,
        ),
      );
      southThread = await asBusiness(owner, south, async () =>
        Number(
          (
            await pool.query(
              "INSERT INTO chat_threads(user_id,title) VALUES($1,'South fixture') RETURNING id",
              [owner],
            )
          ).rows[0].id,
        ),
      );
    });
    afterAll(async () => {
      await pool?.end();
      await admin?.end();
    });
    it("uses one payer and one workspace per profile, and counts owner once", async () => {
      const profiles = await staff.accessibleBusinessProfiles(owner);
      expect(profiles.map((p) => p.id)).toEqual([north, south]);
      expect(
        profiles.every(
          (p) => p.billingOrganizationId === payer && p.canManageTeam,
        ),
      ).toBe(true);
      expect((await staff.listBusinessStaff(owner, north)).members).toEqual([
        expect.objectContaining({ userId: owner, role: "owner" }),
      ]);
      expect(
        (
          await admin.query(
            "SELECT resource_key,usage::int FROM billing_capacity_totals WHERE organization_id=$1 AND resource_key IN ('members','businessProfiles','workspaces') ORDER BY resource_key",
            [payer],
          )
        ).rows,
      ).toEqual([
        { resource_key: "businessProfiles", usage: 2 },
        { resource_key: "members", usage: 1 },
        { resource_key: "workspaces", usage: 2 },
      ]);
    });
    it("requires matching verified email before granting profile access", async () => {
      const email = (
        await admin.query("SELECT email FROM users WHERE id=$1", [member])
      ).rows[0].email;
      membership = (
        await asBusiness(owner, north, () =>
          staff.inviteBusinessStaff(
            owner,
            north,
            email.toUpperCase(),
            "member",
          ),
        )
      ).member.id;
      expect(await staff.accessibleBusinessProfiles(member)).toEqual([]);
      expect(
        (await staff.listBusinessInvitations(member)).invitations[0]
          .businessProfileId,
      ).toBe(north);
      await expect(
        staff.acceptBusinessInvitation(stranger, membership),
      ).rejects.toMatchObject({ code: "INVITATION_NOT_FOUND" });
      await admin.query("UPDATE users SET is_verified=false WHERE id=$1", [
        member,
      ]);
      await expect(
        staff.acceptBusinessInvitation(member, membership),
      ).rejects.toMatchObject({ code: "VERIFIED_EMAIL_REQUIRED" });
      await admin.query("UPDATE users SET is_verified=true WHERE id=$1", [
        member,
      ]);
      expect(
        (await staff.acceptBusinessInvitation(member, membership))
          .businessProfile,
      ).toMatchObject({
        id: north,
        userId: owner,
        role: "member",
        canManageTeam: false,
        canManageBilling: false,
        isDefault: true,
      });
      expect(
        (await staff.acceptBusinessInvitation(member, membership))
          .businessProfile.id,
      ).toBe(north);
      expect(
        (await staff.accessibleBusinessProfiles(member)).map((p) => p.id),
      ).toEqual([north]);
    });
    it("uses owner for records, actor for permission, and isolates sibling businesses at SQL and HTTP boundaries", async () => {
      expect(await resolveBusinessScope(member, north)).toMatchObject({
        userId: owner,
        actorUserId: member,
        role: "member",
        businessProfileId: north,
      });
      await asBusiness(member, north, async () => {
        expect(businessOwnerUserId({ user: { id: member } } as Request)).toBe(
          owner,
        );
        expect(
          (
            await pool.query("SELECT id FROM chat_threads WHERE user_id=$1", [
              owner,
            ])
          ).rows,
        ).toEqual([{ id: northThread }]);
        expect(
          (
            await pool.query("SELECT id FROM chat_threads WHERE id=$1", [
              southThread,
            ])
          ).rowCount,
        ).toBe(0);
        await expect(
          pool.query(
            "INSERT INTO chat_threads(user_id,business_profile_id,title) VALUES($1,$2,'forbidden')",
            [owner, south],
          ),
        ).rejects.toThrow();
        await expect(
          pool.query(
            "INSERT INTO chat_threads(user_id,title) VALUES($1,'wrong owner')",
            [member],
          ),
        ).rejects.toThrow();
      });
      expect(await resolveBusinessScope(member, south)).toBeNull();
      await asBusiness(member, south, async () =>
        expect(
          (
            await pool.query("SELECT id FROM chat_threads WHERE id=$1", [
              southThread,
            ])
          ).rowCount,
        ).toBe(0),
      );
      const req = {
        user: { id: member },
        originalUrl: "/api/wallet",
        headers: { "x-business-profile-id": String(south) },
        query: {},
      } as unknown as Request;
      const res = response(),
        next = jest.fn();
      await businessProfileScope(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });
    it("derives billing from profile and retains staff authority during aggregate reads", async () => {
      await asBusiness(member, north, async () => {
        expect(await billing.resolveBillingOrganization(owner)).toBe(payer);
        expect(await billing.getBillingOrganization(member)).toMatchObject({
          id: payer,
          businessProfileId: north,
          name: "North",
          role: "member",
          canManageBilling: false,
        });
        await expect(billing.requireBillingRole(member)).rejects.toMatchObject({
          code: "BILLING_ROLE_REQUIRED",
        });
        await withBillingScope(
          {
            organizationId: payer,
            actorUserId: member,
            businessProfileId: north,
            businessOwnerUserId: owner,
          },
          () =>
            withSystemScope("Test authorized billing aggregate", async () =>
              expect(await billing.resolveBillingOrganization(member)).toBe(
                payer,
              ),
            ),
        );
        const req = {
          user: { id: member },
          method: "GET",
          originalUrl: "/api/wallet",
          headers: { "x-billing-organization-id": String(memberPayer) },
        } as unknown as Request;
        const res = response(),
          next = jest.fn();
        await billingOrganizationScope(req, res, next);
        expect(res.status).toHaveBeenCalledWith(409);
        expect(next).not.toHaveBeenCalled();
      });
      await asBusiness(owner, south, async () =>
        expect(await billing.resolveBillingOrganization(owner)).toBe(payer),
      );
    });
    it("rejects role escalation and reserves support-login administration for owner", async () => {
      await expect(
        staff.inviteBusinessStaff(
          member,
          north,
          "other@example.invalid",
          "billing_admin",
        ),
      ).rejects.toMatchObject({ code: "BUSINESS_OWNER_REQUIRED" });
      await expect(
        staff.changeBusinessStaff(member, north, membership, "billing_admin"),
      ).rejects.toMatchObject({ code: "BUSINESS_OWNER_REQUIRED" });
      await asBusiness(owner, north, () =>
        staff.changeBusinessStaff(owner, north, membership, "billing_admin"),
      );
      await asBusiness(member, north, async () =>
        expect(
          (await billing.requireBillingRole(member)).canManageBilling,
        ).toBe(true),
      );
      const req = {
        user: { id: member },
        method: "PUT",
        originalUrl: "/api/support/teams/1/members/2/reset-password",
      } as unknown as Request;
      const res = response(),
        next = jest.fn();
      await asBusiness(member, north, () =>
        businessPermissions(req, res, next),
      );
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
      await asBusiness(owner, north, () =>
        staff.changeBusinessStaff(owner, north, membership, "member"),
      );
    });
    it("connects AI websites and their branding adapters to the business staff list", async () => {
      await asBusiness(owner, north, async () => {
        workspaceId = Number(
          (
            await pool.query(
              "INSERT INTO ai_visibility_workspaces(owner_user_id,business_profile_id,name) VALUES($1,$2,'adapter') RETURNING id",
              [owner, north],
            )
          ).rows[0].id,
        );
        projectId = Number(
          (
            await pool.query(
              "INSERT INTO ai_visibility_projects(user_id,workspace_id,name,domain) VALUES($1,$2,'North site','example.invalid') RETURNING id",
              [owner, workspaceId],
            )
          ).rows[0].id,
        );
      });
      await asBusiness(member, north, async () => {
        const access = await ai.projectAccess(member, projectId);
        expect(access).toMatchObject({
          role: "member",
          ownerUserId: owner,
          workspaceName: "North",
        });
        expect(ai.hasCapability(access.role, "bill_wallet")).toBe(true);
        expect(ai.hasCapability(access.role, "manage_members")).toBe(false);
        expect(
          (await ai.listWorkspaces(member))[0].workspace.businessProfileId,
        ).toBe(north);
      });
      await asBusiness(
        owner,
        south,
        async () =>
          await expect(
            ai.projectAccess(owner, projectId),
          ).rejects.toMatchObject({ statusCode: 404 }),
      );
    });
    it("allows a staff user to create an independently owned business from a selected shared profile", async () => {
      const req = {
        user: { id: member },
        method: "POST",
        originalUrl: "/api/settings/business-profiles",
        headers: { "x-billing-organization-id": String(payer) },
      } as unknown as Request;
      const res = response();
      let called = false;
      await asBusiness(member, north, () =>
        billingOrganizationScope(req, res, async () => {
          called = true;
          expect(currentBusinessScope()).toBeUndefined();
          expect(await billing.resolveBillingOrganization(member)).toBe(
            memberPayer,
          );
        }),
      );
      expect(called).toBe(true);
    });
    it("charges one shared wallet and records the actual staff actor", async () => {
      await asBusiness(owner, north, () => getOrCreateWallet(owner));
      await admin.query(
        "UPDATE wallets SET balance=100 WHERE organization_id=$1",
        [payer],
      );
      const first = await asBusiness(member, north, () =>
        creditService.deductForEvent({
          userId: owner,
          eventKey: "qa_staff",
          description: "QA shared credits",
          overrideAmount: 7,
        }),
      );
      expect(first).toMatchObject({ success: true, balanceAfter: 93 });
      deductionId = first.transactionId!;
      expect(
        (
          await admin.query(
            "SELECT organization_id,actor_user_id,billing_business_profile_id FROM wallet_transactions WHERE id=$1",
            [deductionId],
          )
        ).rows[0],
      ).toEqual({
        organization_id: payer,
        actor_user_id: member,
        billing_business_profile_id: north,
      });
      expect(await asBusiness(owner, south, () => getBalance(owner))).toBe(93);
      expect(
        await asBusiness(owner, south, () =>
          creditService.deductForEvent({
            userId: owner,
            eventKey: "qa_owner",
            description: "QA shared credits",
            overrideAmount: 3,
          }),
        ),
      ).toMatchObject({ success: true, balanceAfter: 90 });
      expect(await asBusiness(member, north, () => getBalance(owner))).toBe(90);
    });
    it("pins the actual staff actor when queueing without a billing scope", async () => {
      captured = await asBusiness(member, north, () =>
        captureJobBusiness({ userId: owner, type: "test" }),
      );
      expect(captured).toMatchObject({
        businessActorUserId: member,
        billingActorUserId: member,
        billingOrganizationId: payer,
        businessProfileId: north,
      });
      await runBusinessJob(captured, async () =>
        expect(currentBusinessScope()).toMatchObject({
          userId: owner,
          actorUserId: member,
        }),
      );
    });
    it("removes data, billing, and queued work on revocation while preserving the original refund payer", async () => {
      await asBusiness(owner, north, () =>
        staff.changeBusinessStaff(owner, north, membership),
      );
      expect(await resolveBusinessScope(member, north)).toBeNull();
      await asBusiness(member, north, async () => {
        expect(
          (
            await pool.query("SELECT id FROM chat_threads WHERE id=$1", [
              northThread,
            ])
          ).rowCount,
        ).toBe(0);
        await expect(
          billing.resolveBillingOrganization(owner),
        ).rejects.toMatchObject({ code: "ORGANIZATION_FORBIDDEN" });
      });
      const work = jest.fn<() => Promise<void>>(),
        cleanup = jest.fn(async (data: { billingOrganizationId?: number }) => {
          expect(data.billingOrganizationId).toBe(payer);
          expect(currentBusinessScope()?.actorUserId).toBeUndefined();
          expect(
            await creditService.refundDeduction({
              userId: owner,
              transactionId: deductionId,
              description: "QA rejected job",
            }),
          ).toMatchObject({
            success: true,
            creditsRefunded: 7,
            balanceAfter: 97,
          });
        });
      await expect(
        runBusinessJob(captured, work, cleanup),
      ).rejects.toMatchObject({ code: "ORGANIZATION_FORBIDDEN" });
      expect(work).not.toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalledTimes(1);
      const audit = await admin.query(
        "SELECT actor_user_id,action FROM business_profile_membership_audit WHERE business_profile_id=$1 ORDER BY id",
        [north],
      );
      expect(audit.rows).toEqual(
        expect.arrayContaining([
          { actor_user_id: owner, action: "staff.invited" },
          { actor_user_id: member, action: "staff.accepted" },
          { actor_user_id: owner, action: "staff.revoked" },
        ]),
      );
      const result = await withSystemScope("Test quota reconciliation", () =>
        appDb.execute(
          sql`SELECT billing_capacity_reconciliation(${payer}) AS result`,
        ),
      );
      expect(result.rows[0].result).toEqual([]);
    });
  },
);
