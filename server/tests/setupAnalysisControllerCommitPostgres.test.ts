import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { Pool, type PoolClient, type QueryConfig } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { randomUUID } from "node:crypto";
import { createBusinessScopedPool } from "../tenancy/scopedPool.js";
import { assertBusinessScopeSchema } from "../tenancy/schemaGuard.js";
import { withBusinessScope } from "../tenancy/businessContext.js";

const database = process.env.SETUP_COMMIT_TEST_DATABASE;
const suite = database ? describe : describe.skip;
let admin: Pool, pool: Pool;
let owner: number, profile: number, jobId: string;
let failCommit: number | undefined,
  callbackCount = 0;
const callbacks: Array<{ number: number; writes: string[] }> = [];
const prior = {
  data: { companyName: "Prior controller analysis" },
  marker: "unchanged on abort",
};
const executeDb = new Proxy(
  {},
  { get: (_target, key) => Reflect.get(drizzle(pool), key) },
);
jest.unstable_mockModule("../models/db.js", () => ({ db: executeDb }));
jest.unstable_mockModule("../queues/index.js", () => ({
  QUEUE_NAMES: { GENERAL: "general" },
  queueRegistry: {
    initialize: async () => undefined,
    addJob: async () => "fixture",
  },
}));
const text =
  "Synthetic Studio provides practical tutorials and community support for independent creators. Our team helps people write, design and publish useful work. This text is a disposable local provider fixture.";
jest.unstable_mockModule("../services/WebsiteCrawlerService.js", () => ({
  WebsiteCrawlerService: class {
    async fetchPage() {
      return {
        success: true,
        _html: `<html><body><h1>Synthetic Studio</h1><p>${text}</p></body></html>`,
        text,
        title: "Synthetic Studio",
        url: "https://controller-commit.example/",
      };
    }
    extractLinks() {
      return [];
    }
    buildContent() {
      return text;
    }
  },
}));
jest.unstable_mockModule("../services/agents/LLMProviderFactory.js", () => ({
  LLMProviderFactory: {
    createProviderForUser: async () => ({
      defaultModel: "fixture",
      createChatCompletion: async () => ({
        success: true,
        content: JSON.stringify({
          companyName: "Synthetic Studio",
          description: text,
        }),
      }),
    }),
    handleRateLimitError: async () => {
      throw Error("Synthetic provider unavailable");
    },
  },
}));
jest.unstable_mockModule("../services/knowledge/KnowledgeGateway.js", () => ({
  knowledgeGateway: { retrieveText: async () => "" },
}));
jest.unstable_mockModule("../services/agents/WebSocketEmitter.js", () => ({
  webSocketEmitter: { emit: async () => undefined },
}));
jest.unstable_mockModule("../services/embeddings/EmbeddingService.js", () => ({
  embeddingService: {
    generateEmbeddingsBatch: async () => ({
      vectors: [[0.1, 0.2]],
      model: "fixture",
    }),
  },
}));
jest.unstable_mockModule("../utils/browserAutomation.js", () => ({
  launchSystemChromium: async () => {
    throw Error("Fixture screenshot unavailable");
  },
}));
jest.unstable_mockModule("../services/StorageService.js", () => ({
  StorageService: {
    getInstance: () => ({
      upload: async () => ({ url: "/uploads/fixture.png" }),
    }),
  },
}));
jest.unstable_mockModule("../utils/logger.js", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Abort the actual callback transaction before COMMIT is sent. There is no
// uncertain commit outcome, provider call, authorization bypass or fake SQL result.
function instrument(native: Pool): Pool {
  return new Proxy(native, {
    get: (target, key) => {
      if (key === "connect")
        return async () => {
          const client = await target.connect();
          let callback: { number: number; writes: string[] } | undefined;
          return new Proxy(client, {
            get: (connection, property) => {
              if (property === "query")
                return async (
                  query: string | QueryConfig,
                  values?: unknown[],
                ) => {
                  const sql = typeof query === "string" ? query : query.text;
                  if (sql.includes("pg_advisory_xact_lock(740322")) {
                    callback = { number: ++callbackCount, writes: [] };
                    callbacks.push(callback);
                  }
                  if (/^(?:insert|update)\b/i.test(sql.trim()) && callback)
                    callback.writes.push(sql);
                  if (
                    /^commit\b/i.test(sql.trim()) &&
                    callback?.number === failCommit &&
                    failCommit !== undefined
                  ) {
                    failCommit = undefined;
                    throw Error("synthetic callback commit abort before send");
                  }
                  const result = await connection.query(query, values);
                  if (/^(?:commit|rollback)\b/i.test(sql.trim()))
                    callback = undefined;
                  return result;
                };
              const value = Reflect.get(
                connection,
                property,
                connection,
              ) as unknown;
              return typeof value === "function"
                ? value.bind(connection)
                : value;
            },
          }) as PoolClient;
        };
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const { processWorkspaceWebsiteAnalysis } =
  await import("../services/workspaceWebsiteAnalysisJobs.js");
function run() {
  return withBusinessScope(
    { userId: owner, businessProfileId: profile, actorUserId: owner },
    () =>
      processWorkspaceWebsiteAnalysis({
        data: { analysisJobId: jobId },
        opts: { attempts: 1 },
      }),
  );
}
async function state() {
  const row = (
    await admin.query(
      "SELECT j.status,j.result,p.website_analysis FROM workspace_website_analysis_jobs j JOIN company_settings p ON p.id=j.business_profile_id WHERE j.id=$1",
      [jobId],
    )
  ).rows[0];
  const entries = (
    await admin.query(
      "SELECT id FROM knowledge_base WHERE user_id=$1 AND business_profile_id=$2",
      [owner, profile],
    )
  ).rows;
  return { row, entries };
}

suite("production analysis controller transaction boundaries", () => {
  beforeAll(async () => {
    if (!database?.startsWith("salesmarketing_workspace_recovery_qa_"))
      throw Error("Use a disposable setup recovery database.");
    admin = new Pool({ host: "/tmp", database, max: 1 });
    pool = createBusinessScopedPool(
      instrument(new Pool({ host: "/tmp", database, max: 4 })),
    );
    await assertBusinessScopeSchema(admin);
    owner = (
      await admin.query(
        "INSERT INTO users(email,password,name,is_approved) VALUES($1,'synthetic','Controller fixture',true) RETURNING id",
        [`controller-${randomUUID()}@example.invalid`],
      )
    ).rows[0].id;
  });
  beforeEach(async () => {
    failCommit = undefined;
    callbackCount = 0;
    callbacks.length = 0;
    profile = (
      await admin.query(
        "INSERT INTO company_settings(user_id,name,website_analysis) VALUES($1,'Controller fixture',$2::jsonb) RETURNING id",
        [owner, JSON.stringify(prior)],
      )
    ).rows[0].id;
    jobId = randomUUID();
    await withBusinessScope({ userId: owner, businessProfileId: profile }, () =>
      pool.query(
        "INSERT INTO workspace_website_analysis_jobs(id,user_id,business_profile_id,url,force_refresh,status) VALUES($1,$2,$3,'https://controller-commit.example/',true,'queued')",
        [jobId, owner, profile],
      ),
    );
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  it("enlists real knowledge and profile writes in the production controller's separate callbacks", async () => {
    await run();
    const { row, entries } = await state();
    expect(row.status).toBe("completed");
    expect(entries).toHaveLength(1);
    expect(row.website_analysis.kbEntryId).toBe(entries[0].id);
    expect(callbacks).toHaveLength(2);
    expect(
      callbacks[0].writes.some((sql) => sql.includes('"knowledge_base"')),
    ).toBe(true);
    expect(
      callbacks[1].writes.some((sql) => sql.includes('"company_settings"')),
    ).toBe(true);
  });
  it("rolls back a knowledge commit abort while preserving the existing extraction-with-warning behavior", async () => {
    failCommit = 1;
    await run();
    const { row, entries } = await state();
    expect(row.status).toBe("completed");
    expect(entries).toEqual([]);
    expect(row.result.kbEntryId).toBeNull();
    expect(row.website_analysis.summary).toMatchObject({
      knowledgeSaved: false,
      warnings: [expect.stringContaining("could not be saved")],
    });
  });
  it("rolls back a later profile commit abort without undoing the earlier knowledge callback", async () => {
    failCommit = 2;
    await expect(run()).rejects.toThrow("Website analysis was interrupted");
    const { row, entries } = await state();
    expect(row.status).toBe("failed");
    expect(row.website_analysis).toEqual(prior);
    expect(entries).toHaveLength(1);
  });
});
