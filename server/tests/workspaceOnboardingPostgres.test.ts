import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { createBusinessScopedPool } from "../tenancy/scopedPool.js";
import { withBusinessScope } from "../tenancy/businessContext.js";

const target = process.env.WORKSPACE_ONBOARDING_TEST_DATABASE;
const suite = target ? describe : describe.skip;
let pool: Pool;
let admin: Pool;
let database: NodePgDatabase;
let lastDatabaseError: unknown;
const proxy = new Proxy(
  {},
  {
    get: (_object, key) => {
      const value = database[key as keyof NodePgDatabase];
      return typeof value === "function" ? value.bind(database) : value;
    },
  },
);
jest.unstable_mockModule("../models/db.js", () => ({ db: proxy }));
jest.unstable_mockModule("../utils/logger.js", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn((context: { err?: unknown }) => {
      lastDatabaseError = context.err;
    }),
    debug: jest.fn(),
  },
}));
jest.unstable_mockModule("../services/StorageService.js", () => ({
  storageService: { upload: async () => ({ url: "/uploads/fixture/image.png" }), deleteByUrl: async () => {} },
  StorageService: {
    getInstance: () => ({
      upload: async () => ({ url: "/uploads/fixture/image.png" }),
      deleteByUrl: async () => {},
    }),
  },
}));
const profiles = await import("../controllers/businessProfilesController.js");
const toolkits = await import("../controllers/brandToolkitController.js");
const { saveWorkspaceWebsiteAnalysis } = await import(
  "../services/workspaceWebsiteAnalysis.js"
);
const { KnowledgeBaseModel } = await import(
  "../models/knowledgeBase/functions.js"
);

function response() {
  const state: { status: number; body?: unknown; databaseError?: unknown } = {
    status: 200,
  };
  const res = {
    status(code: number) {
      state.status = code;
      if (code === 500) state.databaseError = lastDatabaseError;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
  };
  return { state, res: res as Response };
}
function request(userId: number, body: Record<string, unknown>, id?: number) {
  return {
    user: { id: userId },
    body,
    params: { id: String(id) },
  } as unknown as Request;
}

suite(
  "workspace onboarding through migrated PostgreSQL and API controllers",
  () => {
    let userId: number, otherUserId: number, firstId: number, secondId: number;
    beforeAll(async () => {
      if (!target?.startsWith("salesmarketing_workspace_onboarding_qa_"))
        throw new Error("Use a disposable workspace onboarding QA database.");
      admin = new Pool({ host: "/tmp", database: target, max: 1 });
      pool = createBusinessScopedPool(
        new Pool({ host: "/tmp", database: target, max: 2 }),
      );
      database = drizzle(pool);
      const suffix = randomUUID();
      const users = await admin.query(
        "INSERT INTO users(email,password,name,is_approved) VALUES($1,'fixture','Onboarding owner',true),($2,'fixture','Other owner',true) RETURNING id",
        [
          "onboarding-" + suffix + "@example.invalid",
          "other-" + suffix + "@example.invalid",
        ],
      );
      [userId, otherUserId] = users.rows.map((row) => row.id);
    });
    afterAll(async () => {
      await pool?.end();
      await admin?.end();
    });

    it("creates a creator workspace and preserves advanced legacy fields during simple editing", async () => {
      const created = response();
      await profiles.createBusinessProfile(
        request(userId, {
          name: "Creator Studio",
          companyName: "Creator Studio",
          workspaceType: "creator",
          timezone: "Asia/Kolkata",
          applicationUses: ["customer_support", "content_social"],
          setupGoal: "Reply faster",
          currentTools: "Instagram",
          profileType: "SaaS",
          businessGoals: ["brand_awareness"],
          keyBuyerRoles: ["Founder"],
          restrictions: "No exaggerated claims",
          linkedinUrl: "https://linkedin.com/company/creator",
        }),
        created.res,
      );
      expect(created.state).toMatchObject({ status: 201 });
      firstId = (created.state.body as { id: number }).id;
      const edited = response();
      await profiles.updateBusinessProfile(
        request(
          userId,
          {
            name: "Creator North",
            companyName: "Creator North",
            description: "I create tutorials.",
            applicationUses: ["personal_productivity"],
            preferredChannels: ["Email"],
            setupGoal: "Publish a tutorial",
          },
          firstId,
        ),
        edited.res,
      );
      expect(edited.state.status).toBe(200);
      expect(edited.state.body).toMatchObject({
        name: "Creator North",
        workspaceType: "creator",
        timezone: "Asia/Kolkata",
        applicationUses: ["personal_productivity"],
        profileType: "SaaS",
        businessGoals: '["brand_awareness"]',
        keyBuyerRoles: '["Founder"]',
        restrictions: "No exaggerated claims",
        linkedinUrl: "https://linkedin.com/company/creator",
      });
    });
    it("saves analysis to the active workspace and never reuses another workspace’s URL cache", async () => {
      const created = response();
      await profiles.createBusinessProfile(
        request(userId, { name: "Second workspace" }),
        created.res,
      );
      expect(created.state).toMatchObject({ status: 201 });
      secondId = (created.state.body as { id: number }).id;
      const url = "https://onboarding.example";
      await withBusinessScope(
        { userId, businessProfileId: firstId },
        async () => {
          const kb = await KnowledgeBaseModel.create({
            userId,
            businessProfileId: firstId,
            title: "Website",
            type: "url",
            sourceUrl: url,
            content: '{"extractedData":{"companyName":"First"}}',
          });
          await saveWorkspaceWebsiteAnalysis(
            userId,
            firstId,
            url,
            {
              companyName: "Creator North",
              extractedImages: [{ url: "/uploads/first/image.png" }],
            },
            kb.id,
            { pages: 2, knowledgeSaved: true, warnings: [] },
          );
          await expect(
            saveWorkspaceWebsiteAnalysis(userId, secondId, url, {}, null, {
              pages: 0,
              knowledgeSaved: false,
              warnings: [],
            }),
          ).rejects.toThrow("active workspace");
        },
      );
      await withBusinessScope(
        { userId, businessProfileId: secondId },
        async () =>
          expect(
            await KnowledgeBaseModel.findBySourceUrl(userId, url, secondId),
          ).toBeNull(),
      );
      const saved = await admin.query(
        "SELECT id,website_analysis FROM company_settings WHERE id=ANY($1)",
        [[firstId, secondId]],
      );
      expect(
        saved.rows.find((row) => row.id === firstId).website_analysis.data
          .extractedImages,
      ).toEqual([{ url: "/uploads/first/image.png" }]);
      expect(
        saved.rows.find((row) => row.id === secondId).website_analysis,
      ).toBeNull();
    });
    it("keeps images, screenshot, fonts and guidance in the created toolkit and scopes it to its workspace", async () => {
      await withBusinessScope(
        { userId, businessProfileId: firstId },
        async () => {
          const created = response();
          await toolkits.createBrandToolkit(
            request(userId, {
              name: "Creator toolkit",
              isDefault: true,
              imageAssets: [
                {
                  url: "/uploads/first/image.png",
                  originalUrl: "https://onboarding.example/image.png",
                },
              ],
              websiteScreenshotUrl: "/uploads/first/screenshot.png",
              fontFamilies: ["Inter"],
              fonts: { heading: "Inter", body: "Inter" },
              voiceDos: ["Use plain words"],
              gradients: ["linear-gradient(#112233,#445566)"],
            }),
            created.res,
          );
          expect(created.state.status).toBe(201);
          expect(created.state.body).toMatchObject({
            businessProfileId: firstId,
            imageAssets: [
              {
                url: "/uploads/first/image.png",
                originalUrl: "https://onboarding.example/image.png",
              },
            ],
            websiteScreenshotUrl: "/uploads/first/screenshot.png",
            voiceDos: ["Use plain words"],
            fontFamilies: ["Inter"],
          });
          const edited = response();
          await toolkits.updateBrandToolkit(
            request(
              userId,
              { name: "Renamed toolkit" },
              (created.state.body as { id: number }).id,
            ),
            edited.res,
          );
          expect(edited.state.body).toMatchObject({
            imageAssets: [
              {
                url: "/uploads/first/image.png",
                originalUrl: "https://onboarding.example/image.png",
              },
            ],
            voiceDos: ["Use plain words"],
          });
        },
      );
      await withBusinessScope(
        { userId, businessProfileId: secondId },
        async () => {
          const listed = response();
          await toolkits.getBrandToolkits(request(userId, {}), listed.res);
          expect(listed.state.body).toEqual([]);
        },
      );
    });
    it("rejects another owner and invalid onboarding details without mutating the profile", async () => {
      const denied = response();
      await profiles.updateBusinessProfile(
        request(otherUserId, { name: "Wrong owner" }, firstId),
        denied.res,
      );
      expect(denied.state.status).toBe(404);
      const invalid = response();
      await profiles.updateBusinessProfile(
        request(userId, { applicationUses: ["not_supported"] }, firstId),
        invalid.res,
      );
      expect(invalid.state.status).toBe(400);
      const row = await admin.query(
        "SELECT name,application_uses FROM company_settings WHERE id=$1",
        [firstId],
      );
      expect(row.rows[0]).toMatchObject({
        name: "Creator North",
        application_uses: ["personal_productivity"],
      });
    });
  },
);
