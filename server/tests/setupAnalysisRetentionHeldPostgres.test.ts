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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBusinessScopedPool } from "../tenancy/scopedPool.js";
import { assertBusinessScopeSchema } from "../tenancy/schemaGuard.js";
import { withBusinessScope } from "../tenancy/businessContext.js";

const database = process.env.SETUP_COMMIT_TEST_DATABASE;
const suite = database && process.env.SETUP_RETENTION_EVIDENCE ? describe : describe.skip;
let admin: Pool, pool: Pool;
let owner: number, profile: number, jobId: string;
let failCommit: number | undefined,
  callbackCount = 0;
let pauseAfter: number | undefined;
let pauseCompletion = false;
let arrived: (() => void) | undefined;
let resume: Promise<void> | undefined;
let crawls = 0;
const objects: string[] = [];
const observations: Record<string, unknown> = {};
const evidence = process.env.SETUP_RETENTION_EVIDENCE;
function holdAfterCommit(number: number) {
  let release!: () => void;
  pauseAfter = number;
  const reached = new Promise<void>(resolve => { arrived = resolve; });
  resume = new Promise<void>(resolve => { release = resolve; });
  return { reached, release };
}
function holdBeforeCompletion() {
  let release!: () => void;
  pauseCompletion = true;
  const reached = new Promise<void>(resolve => { arrived = resolve; });
  resume = new Promise<void>(resolve => { release = resolve; });
  return { reached, release };
}
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
      crawls++;
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
  launchSystemChromium: async () => ({
    newPage: async () => ({ setViewportSize: async () => undefined, goto: async () => undefined,
      screenshot: async () => Buffer.from('synthetic screenshot fixture, no browser or network') }),
    close: async () => undefined,
  }),
}));
jest.unstable_mockModule("../services/StorageService.js", () => ({
  StorageService: {
    getInstance: () => ({
      upload: async (bytes: Buffer) => {
        const name = `${randomUUID()}.bin`;
        mkdirSync(join(evidence!, 'objects'), { recursive: true });
        writeFileSync(join(evidence!, 'objects', name), bytes);
        objects.push(name);
        return { url: `/uploads/synthetic-retention/${name}` };
      },
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
                  if (pauseCompletion && /UPDATE workspace_website_analysis_jobs SET status='completed'/.test(sql)) {
                    pauseCompletion = false; arrived?.(); await resume;
                  }
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
                  const hold = /^commit\b/i.test(sql.trim()) && callback?.number === pauseAfter && pauseAfter !== undefined;
                  if (/^(?:commit|rollback)\b/i.test(sql.trim())) callback = undefined;
                  if (hold) { pauseAfter = undefined; arrived?.(); await resume; }
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

const { logger } = await import("../utils/logger.js");
const { processWorkspaceWebsiteAnalysis, cancelAnalysis, getAnalysisJob, analysisJobView } =
  await import("../services/workspaceWebsiteAnalysisJobs.js");
function scoped<T>(work: () => Promise<T>) {
 return withBusinessScope({ userId: owner, businessProfileId: profile, actorUserId: owner }, work);
}
function run(attempts = 1, attemptsMade = 0) {
  return withBusinessScope(
    { userId: owner, businessProfileId: profile, actorUserId: owner },
    () =>
      processWorkspaceWebsiteAnalysis({
        data: { analysisJobId: jobId },
        opts: { attempts }, attemptsMade,
      }),
  );
}
async function state() {
  const row = (
    await admin.query(
      "SELECT j.status,j.stage,j.detail,j.error,j.result,p.website_analysis FROM workspace_website_analysis_jobs j JOIN company_settings p ON p.id=j.business_profile_id WHERE j.id=$1",
      [jobId],
    )
  ).rows[0];
  const entries = (
    await admin.query(
      "SELECT id,source_url FROM knowledge_base WHERE user_id=$1 AND business_profile_id=$2 ORDER BY id",
      [owner, profile],
    )
  ).rows;
  return { row, entries };
}

async function fresh(forceRefresh = true) {
    profile = (
      await admin.query(
        "INSERT INTO company_settings(user_id,name,website_analysis) VALUES($1,'Controller fixture',$2::jsonb) RETURNING id",
        [owner, JSON.stringify(prior)],
      )
    ).rows[0].id;
    jobId = randomUUID();
    await withBusinessScope({ userId: owner, businessProfileId: profile }, () =>
      pool.query(
        "INSERT INTO workspace_website_analysis_jobs(id,user_id,business_profile_id,url,force_refresh,status) VALUES($1,$2,$3,'https://controller-commit.example/',$4,'queued')",
        [jobId, owner, profile, forceRefresh],
      ),
    );
}
async function record(name: string) {
  const observed = await state();
  const view = await scoped(async () => analysisJobView((await getAnalysisJob(jobId))!));
  observations[name] = { ...observed, view, crawls, objects: [...objects] };
  writeFileSync(join(evidence!, 'observations.json'), JSON.stringify(observations, null, 2));
}
suite("retention observations and final-status regression", () => {
  beforeAll(async () => {
    if (!evidence?.startsWith('/workspace/scratch/onboarding-held-retention-evidence')) throw Error('Explicit local evidence directory required.');
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
    pauseAfter = undefined; pauseCompletion = false; arrived = undefined; resume = undefined; crawls = 0; objects.length = 0; jest.clearAllMocks();
    await fresh();
  });
  afterAll(async () => {
    writeFileSync(join(evidence!, 'observations.json'), JSON.stringify(observations, null, 2));
    await pool?.end();
    await admin?.end();
  });

  it("enlists real knowledge and profile writes in the production controller's separate callbacks", async () => {
    await run();
    const { row, entries } = await state();
    expect(row.status).toBe("completed");
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ event: 'setup_analysis_completed' }), 'Website analysis completed');
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
  it("observes cancellation after the knowledge commit retaining knowledge but preventing the profile commit", async () => {
    const gate = holdAfterCommit(1);
    const work = run();
    try { await gate.reached; await scoped(() => cancelAnalysis(jobId)); }
    finally { gate.release(); }
    await work;
    const beforeReplay = await state();
    expect(beforeReplay.row.status).toBe('cancelled');
    expect(beforeReplay.row.website_analysis).toEqual(prior);
    expect(beforeReplay.entries).toHaveLength(1);
    expect(beforeReplay.row.result).toBeNull();
    expect(objects).toHaveLength(1);
    const previousCrawls = crawls;
    await run();
    expect(crawls).toBe(previousCrawls);
    expect(await state()).toEqual(beforeReplay);
    await record('cancel-after-knowledge');
  });
  it("observes cancellation after both commits retaining the saved profile and knowledge with a cancelled receipt", async () => {
    const gate = holdAfterCommit(2);
    const work = run();
    try { await gate.reached; await scoped(() => cancelAnalysis(jobId)); }
    finally { gate.release(); }
    await work;
    const {row,entries}=await state();
    expect(row.status).toBe('cancelled');
    expect(entries).toHaveLength(1);
    expect(row.website_analysis.kbEntryId).toBe(entries[0].id);
    expect(row.result).toBeNull();
    expect(objects).toHaveLength(1);
    await record('cancel-after-profile');
  });
  it("observes an existing forced retry retaining the first knowledge entry and creating another", async () => {
    failCommit=2;
    await expect(run(3,0)).rejects.toThrow('Website analysis was interrupted');
    const first=await state();
    expect(first.row.status).toBe('queued');
    expect(first.entries).toHaveLength(1);
    expect(first.row.website_analysis).toEqual(prior);
    await record('force-refresh-retry-before');
    await run(3,1);
    const second=await state();
    expect(second.row.status).toBe('completed');
    expect(second.entries).toHaveLength(2);
    expect(second.row.website_analysis.kbEntryId).toBe(second.entries[1].id);
    expect(objects).toHaveLength(2);
    await record('force-refresh-retry-after');
  });
  it("observes non-forced retry reusing the already committed cache without a second crawl or knowledge insert", async () => {
    await fresh(false);
    failCommit=2;
    await expect(run(3,0)).rejects.toThrow('Website analysis was interrupted');
    const first=await state();
    expect(first.row.status).toBe('queued');
    expect(first.entries).toHaveLength(1);
    const previousCrawls=crawls;
    await run(3,1);
    const second=await state();
    expect(second.row.status).toBe('completed');
    expect(second.entries).toHaveLength(1);
    expect(second.row.website_analysis.kbEntryId).toBe(first.entries[0].id);
    expect(crawls).toBe(previousCrawls);
    expect(objects).toHaveLength(1);
    await record('cache-retry-after');
  });

  it("does not report a completed worker event when cancellation wins the final status update", async () => {
    const gate = holdBeforeCompletion();
    const work = run();
    try { await gate.reached; await scoped(() => cancelAnalysis(jobId)); }
    finally { gate.release(); }
    await work;
    const {row,entries}=await state();
    expect(row.status).toBe('cancelled');
    expect(entries).toHaveLength(1);
    expect(row.website_analysis.kbEntryId).toBe(entries[0].id);
    await record('cancel-before-final-job-receipt');
    expect(logger.info).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'setup_analysis_completed' }), expect.anything());
  });

});
