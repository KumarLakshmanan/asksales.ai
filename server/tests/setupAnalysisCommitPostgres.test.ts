import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { randomUUID } from "node:crypto";
import { createBusinessScopedPool } from "../tenancy/scopedPool.js";
import { assertBusinessScopeSchema } from "../tenancy/schemaGuard.js";
import { withBusinessScope } from "../tenancy/businessContext.js";

const database = process.env.SETUP_COMMIT_TEST_DATABASE;
const suite = database ? describe : describe.skip;
let admin: Pool, pool: Pool;
const executeDb = new Proxy(
  {},
  { get: (_target, key) => Reflect.get(drizzle(pool), key) },
);
jest.unstable_mockModule("../models/db.js", () => ({ db: executeDb }));
jest.unstable_mockModule("../queues/index.js", () => ({
  QUEUE_NAMES: { GENERAL: "general" },
  queueRegistry: {
    initialize: async () => undefined,
    addJob: async () => "synthetic-transport",
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

type Mode =
  | "profile-fault"
  | "knowledge-fault"
  | "later-fault"
  | "cancel"
  | "success";
let mode: Mode = "success";
let owner: number, profile: number, jobId: string, title: string;
let entered: (() => void) | undefined, release: (() => void) | undefined;
const priorAnalysis = {
  url: "https://prior.example/",
  data: { companyName: "Prior saved analysis" },
  marker: "retain-existing",
};
const summary = { pages: 2, knowledgeSaved: false, warnings: [] };

jest.unstable_mockModule("../controllers/setupController.js", () => ({
  analyzeWebsite: async (
    _req: unknown,
    res: { json: (body: unknown) => unknown },
  ) => {
    const { withSetupAnalysisCommit } =
      await import("../services/setupAnalysisProgress.js");
    const { saveWorkspaceWebsiteAnalysis } =
      await import("../services/workspaceWebsiteAnalysis.js");
    const { KnowledgeBaseModel } =
      await import("../models/knowledgeBase/functions.js");
    if (mode === "cancel") {
      entered?.();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    let kbId: number | null = null;
    if (["knowledge-fault", "later-fault", "success"].includes(mode)) {
      const entry = await withSetupAnalysisCommit(async (executor) => {
        const saved = await KnowledgeBaseModel.create(
          {
            userId: owner,
            businessProfileId: profile,
            title,
            content: "Synthetic provider extraction",
            type: "url",
            sourceUrl: "https://enlisted.example/",
          },
          executor,
        );
        if (mode === "knowledge-fault")
          throw new Error("synthetic after knowledge insert");
        return saved;
      });
      kbId = entry.id;
    }
    await withSetupAnalysisCommit(async (executor) => {
      await saveWorkspaceWebsiteAnalysis(
        owner,
        profile,
        "https://enlisted.example/",
        { companyName: "New extraction" },
        kbId,
        summary,
        executor,
      );
      if (mode === "profile-fault" || mode === "later-fault")
        throw new Error("synthetic after profile update");
    });
    return res.json({
      success: true,
      data: { companyName: "New extraction" },
      kbEntryId: kbId,
      analysisSummary: summary,
    });
  },
}));

const { processWorkspaceWebsiteAnalysis, cancelAnalysis } =
  await import("../services/workspaceWebsiteAnalysisJobs.js");
const { saveWorkspaceWebsiteAnalysis } =
  await import("../services/workspaceWebsiteAnalysis.js");
const { KnowledgeBaseModel } =
  await import("../models/knowledgeBase/functions.js");
const { withSetupAnalysisCommit } =
  await import("../services/setupAnalysisProgress.js");

function scoped<T>(work: () => Promise<T>) {
  return withBusinessScope(
    { userId: owner, businessProfileId: profile, actorUserId: owner },
    work,
  );
}
function run() {
  return scoped(() =>
    processWorkspaceWebsiteAnalysis({
      data: { analysisJobId: jobId },
      opts: { attempts: 1 },
    }),
  );
}
async function state() {
  const row = (
    await admin.query(
      "SELECT j.status,p.website_analysis FROM workspace_website_analysis_jobs j JOIN company_settings p ON p.id=j.business_profile_id WHERE j.id=$1",
      [jobId],
    )
  ).rows[0];
  const entries = (
    await admin.query(
      "SELECT id FROM knowledge_base WHERE user_id=$1 AND business_profile_id=$2 AND title=$3",
      [owner, profile, title],
    )
  ).rows;
  return { row, entries };
}

suite("setup analysis commit transaction enlistment", () => {
  beforeAll(async () => {
    if (!database?.startsWith("salesmarketing_workspace_recovery_qa_"))
      throw Error("Use a disposable setup recovery fixture database.");
    admin = new Pool({ host: "/tmp", database, max: 1 });
    pool = createBusinessScopedPool(
      new Pool({ host: "/tmp", database, max: 4 }),
    );
    await assertBusinessScopeSchema(admin);
    owner = (
      await admin.query(
        "INSERT INTO users(email,password,name,is_approved) VALUES($1,'synthetic','Commit fixture',true) RETURNING id",
        [`commit-${randomUUID()}@example.invalid`],
      )
    ).rows[0].id;
  });
  beforeEach(async () => {
    mode = "success";
    entered = undefined;
    release = undefined;
    title = `Commit fixture ${randomUUID()}`;
    profile = (
      await admin.query(
        "INSERT INTO company_settings(user_id,name,website_analysis) VALUES($1,$2,$3::jsonb) RETURNING id",
        [owner, title, JSON.stringify(priorAnalysis)],
      )
    ).rows[0].id;
    jobId = randomUUID();
    await scoped(() =>
      pool.query(
        "INSERT INTO workspace_website_analysis_jobs(id,user_id,business_profile_id,url,status) VALUES($1,$2,$3,'https://enlisted.example/','queued')",
        [jobId, owner, profile],
      ),
    );
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  it("rolls back an enlisted profile update when its callback throws", async () => {
    mode = "profile-fault";
    await expect(run()).rejects.toThrow("synthetic after profile update");
    const { row } = await state();
    expect(row.status).toBe("failed");
    expect(row.website_analysis).toEqual(priorAnalysis);
  });
  it("rolls back an enlisted knowledge insert when its callback throws", async () => {
    mode = "knowledge-fault";
    await expect(run()).rejects.toThrow("synthetic after knowledge insert");
    const { row, entries } = await state();
    expect(row.status).toBe("failed");
    expect(row.website_analysis).toEqual(priorAnalysis);
    expect(entries).toEqual([]);
  });
  it("keeps an earlier successful callback committed when a later callback rolls back", async () => {
    mode = "later-fault";
    await expect(run()).rejects.toThrow("synthetic after profile update");
    const { row, entries } = await state();
    expect(row.status).toBe("failed");
    expect(row.website_analysis).toEqual(priorAnalysis);
    expect(entries).toHaveLength(1);
  });
  it("does not write after cancellation wins before the commit lock", async () => {
    mode = "cancel";
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const work = run();
    try {
      await waiting;
      await scoped(() => cancelAnalysis(jobId));
    } finally {
      release?.();
    }
    await work;
    const { row, entries } = await state();
    expect(row.status).toBe("cancelled");
    expect(row.website_analysis).toEqual(priorAnalysis);
    expect(entries).toEqual([]);
  });
  it("commits normal knowledge and profile handoffs", async () => {
    await run();
    const { row, entries } = await state();
    expect(row.status).toBe("completed");
    expect(entries).toHaveLength(1);
    expect(row.website_analysis).toMatchObject({
      data: { companyName: "New extraction" },
      kbEntryId: entries[0].id,
    });
  });
  it("preserves default-db callers outside a worker commit context", async () => {
    await scoped(async () => {
      const entry = await KnowledgeBaseModel.create({
        userId: owner,
        businessProfileId: profile,
        title,
        content: "Direct caller",
        type: "url",
      });
      await saveWorkspaceWebsiteAnalysis(
        owner,
        profile,
        "https://direct.example/",
        { companyName: "Direct caller" },
        entry.id,
        summary,
      );
      await withSetupAnalysisCommit(async (executor) => {
        expect(executor).toBe(executeDb);
        await saveWorkspaceWebsiteAnalysis(
          owner,
          profile,
          "https://direct.example/",
          { companyName: "Default commit caller" },
          entry.id,
          summary,
          executor,
        );
      });
    });
    expect((await state()).row.website_analysis.data.companyName).toBe(
      "Default commit caller",
    );
  });
});
