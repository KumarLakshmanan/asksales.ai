import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { createBusinessScopedPool } from "../tenancy/scopedPool.js";
import { withBusinessScope } from "../tenancy/businessContext.js";

const target = process.env.ASSISTANTS_TEST_DATABASE;
const suite = target ? describe : describe.skip;
let admin: Pool,
  pool: Pool,
  database: NodePgDatabase,
  userId: number,
  profileId: number,
  secondProfileId: number;
let credentials: any[] = [];
const proxy = new Proxy(
  {},
  {
    get: (_target, key) => {
      const value = database[key as keyof NodePgDatabase];
      return typeof value === "function" ? value.bind(database) : value;
    },
  },
);
jest.unstable_mockModule("../models/db.js", () => ({ db: proxy }));
jest.unstable_mockModule("../models/adminApiCredentials/functions.js", () => ({
  getActiveLLMAdminCredentials: async () => credentials,
  getActiveAdminCredential: jest.fn(),
  getAllActiveAdminCredentials: jest.fn(),
  markAdminCredentialInactive: jest.fn(),
  updateAdminCredentialLastUsed: async () => {},
}));
jest.unstable_mockModule(
  "../models/intentClassifierCredentials/functions.js",
  () => ({
    getActiveClassifierCredentials: async () => [
      {
        validationStatus: "valid",
        apiKey: "offline-classifier",
        config: { model: "configured-classifier" },
      },
    ],
  }),
);
jest.unstable_mockModule("../utils/logger.js", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
// The catalog itself and every resource/account SQL query are real. No
// credential can be used to contact an external provider in this test.
const { assistantCatalog, assistantAccounts, availableAssistantModels } =
  await import("../services/assistants/AssistantCatalogService.js");
function owner<T>(work: () => T, profile = profileId) {
  return withBusinessScope(
    { userId, businessProfileId: profile, actorUserId: userId, role: "owner" },
    work,
  );
}

suite("server-resolved assistant catalog in isolated PostgreSQL", () => {
  beforeAll(async () => {
    if (!target?.startsWith("asksales_assistants_qa_"))
      throw new Error("Only a disposable assistant QA database is permitted.");
    admin = new Pool({
      host: "/tmp",
      database: target,
      max: 1,
      options: "-c timezone=UTC",
    });
    pool = createBusinessScopedPool(
      new Pool({
        host: "/tmp",
        database: target,
        max: 4,
        options: "-c timezone=UTC",
      }),
    );
    database = drizzle(pool);
    userId = Number(
      (
        await admin.query(
          "INSERT INTO users(email,password,name,is_approved) VALUES($1,'fixture','Catalog QA owner',TRUE) RETURNING id",
          [`catalog-${randomUUID()}@example.invalid`],
        )
      ).rows[0].id,
    );
    profileId = Number(
      (
        await admin.query(
          "INSERT INTO company_settings(user_id,name,company_name,is_default) VALUES($1,'Catalog QA','Synthetic Catalog',TRUE) RETURNING id",
          [userId],
        )
      ).rows[0].id,
    );
    secondProfileId = Number(
      (
        await admin.query(
          "INSERT INTO company_settings(user_id,name,company_name,is_default) VALUES($1,'Other catalog QA','Other Synthetic Catalog',FALSE) RETURNING id",
          [userId],
        )
      ).rows[0].id,
    );
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  it("returns only configured available models and never serializes credentials", async () => {
    credentials = [
      {
        id: 1,
        platform: "openai",
        apiKey: "offline-secret-must-not-appear",
        config: {
          selectedModel: "gpt-4o-mini",
          allowedModels: ["gpt-4o-mini", "gpt-5-mini"],
        },
      },
      {
        id: 2,
        platform: "gemini",
        apiKey: "offline-secret-must-not-appear",
        config: {},
      },
      {
        id: 3,
        platform: "custom_ai",
        apiKey: "offline-secret-must-not-appear",
        config: { model: "unavailable-without-endpoint" },
      },
    ];
    const models = await availableAssistantModels();
    expect(models.map((m) => m.model)).toEqual(["gpt-4o-mini", "gpt-5-mini"]);
    expect(models[1].controls).toEqual([]);
    expect(JSON.stringify(models)).not.toMatch(/apiKey|offline-secret|config/);
    credentials = [];
    expect(await availableAssistantModels()).toEqual([]);
  });

  it("loads the actual published-resource SQL without expanding a fresh profile to another business", async () =>
    owner(async () => {
      credentials = [
        {
          id: 1,
          platform: "openai",
          apiKey: "offline-secret",
          config: { selectedModel: "gpt-4o-mini" },
        },
      ];
      const catalog = await assistantCatalog();
      for (const key of [
        "knowledge",
        "playbooks",
        "templates",
        "documents",
        "galleries",
        "accounts",
      ] as const)
        expect(catalog[key]).toEqual([]);
      expect(catalog.models).toHaveLength(1);
      expect(catalog.presets.length).toBeGreaterThan(0);
      expect(JSON.stringify(catalog)).not.toContain("offline-secret");
    }));

  it("verifies original email credential identity instead of whichever Gmail account is selected", async () =>
    owner(async () => {
      const credentialId = Number(
        (
          await database.execute(sql`INSERT INTO channel_credentials(user_id,platform,credential_type,account_identifier,access_token,is_active,is_selected)
      VALUES(${userId},'gmail_api','oauth','support@example.invalid','offline-gmail-secret',TRUE,FALSE) RETURNING id`)
        ).rows[0].id,
      );
      await database.execute(sql`INSERT INTO channel_credentials(user_id,platform,credential_type,account_identifier,access_token,is_active,is_selected)
      VALUES(${userId},'gmail_api','oauth','different@example.invalid','offline-other-secret',TRUE,TRUE)`);
      await database.execute(sql`INSERT INTO email_senders(user_id,type,label,email,is_verified,credential_id)
      VALUES(${userId},'gmail','Original account','support@example.invalid',TRUE,${credentialId}),
        (${userId},'gmail','Mismatched identity','wrong@example.invalid',TRUE,${credentialId}),
        (${userId},'gmail','Unverified','unverified@example.invalid',FALSE,${credentialId})`);
      let accounts = await assistantAccounts();
      expect(
        accounts.find((a) => a.accountId === "support@example.invalid")
          ?.connected,
      ).toBe(true);
      expect(
        accounts.find((a) => a.accountId === "wrong@example.invalid")
      ).toBeUndefined();
      expect(
        accounts.find((a) => a.accountId === "unverified@example.invalid")
      ).toBeUndefined();
      expect(JSON.stringify(accounts)).not.toMatch(
        /offline-.*secret|access_token|refresh_token/,
      );
      await database.execute(
        sql`UPDATE channel_credentials SET is_active=FALSE WHERE id=${credentialId}`,
      );
      accounts = await assistantAccounts();
      expect(
        accounts.find((a) => a.accountId === "support@example.invalid")
      ).toBeUndefined();
      expect(await owner(assistantAccounts, secondProfileId)).toEqual([]);
    }));

  it("offers only current customer-permitted published knowledge sources", async () =>
    owner(async () => {
      const ids: number[] = [];
      for (const fixture of [
        {
          title: "Approved customer source",
          audience: "customer",
          access: "tenant",
          privacy: "business",
          status: "published",
          expired: false,
        },
        {
          title: "Restricted source",
          audience: "customer",
          access: "restricted",
          privacy: "business",
          status: "published",
          expired: false,
        },
        {
          title: "Staff source",
          audience: "internal",
          access: "staff_only",
          privacy: "internal",
          status: "published",
          expired: false,
        },
        {
          title: "Expired source",
          audience: "customer",
          access: "tenant",
          privacy: "business",
          status: "published",
          expired: true,
        },
        {
          title: "Draft source",
          audience: "customer",
          access: "tenant",
          privacy: "business",
          status: "draft",
          expired: false,
        },
      ]) {
        const documentId = Number(
          (
            await database.execute(sql`INSERT INTO knowledge_documents(user_id,source_type,title,audience,access_scope)
        VALUES(${userId},'managed',${fixture.title},${fixture.audience},${fixture.access}) RETURNING id`)
          ).rows[0].id,
        );
        const versionId = Number(
          (
            await database.execute(sql`INSERT INTO knowledge_document_versions(document_id,user_id,version_no,status,content_hash,normalized_content,privacy_classification,expires_at)
        VALUES(${documentId},${userId},1,${fixture.status},${"a".repeat(64)},'Synthetic knowledge',${fixture.privacy},
          ${fixture.expired ? sql`NOW()-INTERVAL '1 day'` : sql`NULL`}) RETURNING id`)
          ).rows[0].id,
        );
        await database.execute(
          sql`UPDATE knowledge_documents SET current_published_version_id=${versionId} WHERE id=${documentId}`,
        );
        ids.push(documentId);
      }
      const available=await assistantCatalog();
      expect(available.knowledge.map((k) => k.id)).toEqual([
        ids[0],
      ]);
      expect(available.unavailableResources?.find(resource=>resource.id===ids[1]&&resource.category==='knowledge')?.availabilityReason).toMatch(/Restricted access/);
      expect(available.unavailableResources?.find(resource=>resource.id===ids[2]&&resource.category==='knowledge')?.availabilityReason).toMatch(/Internal audience/);
      expect(available.unavailableResources?.find(resource=>resource.id===ids[3]&&resource.category==='knowledge')?.availabilityReason).toMatch(/expired/);
      expect(available.unavailableResources?.find(resource=>resource.id===ids[4]&&resource.category==='knowledge')?.availabilityReason).toMatch(/Publish/);
      expect(
        (await owner(assistantCatalog, secondProfileId)).knowledge,
      ).toEqual([]);
    }));

  it("lists only connected, unexpired accounts with private/comment surfaces independently", async () =>
    owner(async () => {
      await database.execute(sql`INSERT INTO meta_page_connections(user_id,page_id,page_name,page_access_token,user_access_token,instagram_account_id,is_active,facebook_active,instagram_active,webhook_subscribed)
      VALUES(${userId},'synthetic-page','Synthetic page','offline-page-secret','offline-user-secret','synthetic-instagram',TRUE,TRUE,TRUE,TRUE),
        (${userId},'missing-secret','Unconnected page','','offline-user-secret',NULL,TRUE,TRUE,FALSE,TRUE)`);
      await database.execute(sql`INSERT INTO channel_credentials(user_id,platform,credential_type,account_identifier,access_token,is_active,token_expiry)
      VALUES(${userId},'whatsapp','oauth','expired-phone','offline-wa-secret',TRUE,NOW()-INTERVAL '1 day'),
        (${userId},'linkedin','oauth','unsupported-channel','offline-secret',TRUE,NULL)`);
      const accounts = await assistantAccounts();
      expect(
        accounts.filter((a) => a.accountId === "synthetic-page"),
      ).toHaveLength(2);
      expect(
        accounts.filter((a) => a.accountId === "synthetic-instagram"),
      ).toHaveLength(2);
      expect(
        accounts
          .filter((a) => a.accountId === "synthetic-page")
          .every((a) => a.connected),
      ).toBe(true);
      expect(
        accounts.some((a) => a.accountId === "missing-secret"),
      ).toBe(false);
      expect(
        accounts.some((a) => a.accountId === "expired-phone"),
      ).toBe(false);
      expect(accounts.some((a) => a.accountId === "unsupported-channel")).toBe(
        false,
      );
    }));
});
