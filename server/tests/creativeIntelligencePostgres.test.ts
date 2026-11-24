import { jest } from "@jest/globals";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { CreativeIntelligenceService } from "../services/ads/creative-intelligence/CreativeIntelligenceService.js";
const migrationPath = "../migrations/287_ad_creative_intelligence.js";
const { up, down } = (await import(migrationPath)) as {
  up(client: Client): Promise<void>;
  down(client: Client): Promise<void>;
};

const connectionString = process.env.CREATIVE_INTELLIGENCE_TEST_DATABASE_URL;
const postgres = connectionString ? describe : describe.skip;
postgres("creative intelligence PostgreSQL contracts (isolated schema)", () => {
  const schema = `creative_test_${process.pid}`;
  let client: Client;
  let connected = false;
  let service: CreativeIntelligenceService;
  const enqueue = jest.fn<(...args: unknown[]) => Promise<void>>();
  const requestId = "a8928c95-862a-46c1-aa2b-19fc9cdbedc6";
  const research = {
    requestId,
    source: "manual",
    references: [
      { pageName: "Competitor", body: "An observed product demonstration" },
    ],
  };
  const previousFlag = process.env.AD_CREATIVE_INTELLIGENCE_ENABLED;
  beforeAll(async () => {
    client = new Client({ connectionString });
    await client.connect();
    connected = true;
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(
      "CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1),(2); CREATE TABLE content_assets(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL); INSERT INTO content_assets VALUES(11,1),(22,2)",
    );
    await up(client);
    // Migration 299 replaces the pre-business retry key. The mounted/RLS suite
    // executes 287/299/325; this isolated-schema test mirrors their final index.
    for (const table of ['ad_creative_research_runs','ad_creative_briefs']) {
      await client.query(`ALTER TABLE ${table} ADD COLUMN business_profile_id integer NOT NULL DEFAULT 11`);
      const constraints = await client.query("SELECT conname FROM pg_constraint WHERE conrelid=$1::regclass AND contype='u' AND conname LIKE '%request_id%'",[table]);
      for (const row of constraints.rows) await client.query(`ALTER TABLE ${table} DROP CONSTRAINT "${row.conname}"`);
      await client.query(`CREATE UNIQUE INDEX ${table}_business_retry ON ${table}(business_profile_id,user_id,request_id)`);
    }
    service = new CreativeIntelligenceService(drizzle(client));
    // Queue transport is external to these real-DB persistence/ownership tests.
    Object.defineProperty(service, "enqueue", { value: enqueue });
    process.env.AD_CREATIVE_INTELLIGENCE_ENABLED = "true";
  });
  afterAll(async () => {
    if (previousFlag === undefined)
      delete process.env.AD_CREATIVE_INTELLIGENCE_ENABLED;
    else process.env.AD_CREATIVE_INTELLIGENCE_ENABLED = previousFlag;
    if (connected) {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.end();
    }
  });
  it("applies migration twice and keeps retry IDs owner-scoped and payload-bound", async () => {
    await up(client);
    const first = await service.createResearch(1, research);
    const retry = await service.createResearch(1, research);
    expect(retry.id).toBe(first.id);
    await expect(
      service.createResearch(1, { ...research, country: "GB" }),
    ).rejects.toThrow("different research");
    const secondOwner = await service.createResearch(2, research);
    expect(secondOwner.id).not.toBe(first.id);
    await expect(service.research(2, first.id)).rejects.toThrow("not found");
  });
  it("retains a queued record after queue failure so identical retries do not duplicate it", async () => {
    enqueue.mockRejectedValueOnce(new Error("offline"));
    const body = {
      ...research,
      requestId: "b8928c95-862a-46c1-aa2b-19fc9cdbedc6",
    };
    await expect(service.createResearch(1, body)).rejects.toThrow("offline");
    const saved = await service.createResearch(1, body);
    const count = await client.query(
      "SELECT COUNT(*)::int AS count FROM ad_creative_research_runs WHERE user_id=1 AND request_id=$1",
      [body.requestId],
    );
    expect(count.rows[0].count).toBe(1);
    expect(saved.status).toBe("queued");
  });
  it("enforces revision conflicts and owned asset links with actual foreign keys", async () => {
    const concepts = [{ id: "concept-a" }, { id: "concept-b" }];
    const inserted = await client.query(
      `INSERT INTO ad_creative_briefs(user_id,request_id,input_hash,input,status,concepts) VALUES(1,$1,'fixture','{}','ready',$2) RETURNING id`,
      [requestId, JSON.stringify(concepts)],
    );
    const id = inserted.rows[0].id;
    await expect(service.brief(2, id)).rejects.toThrow("not found");
    const selected = await service.selectConcept(1, id, 1, "concept-a");
    expect(selected.revision).toBe(2);
    await expect(service.selectConcept(1, id, 1, "concept-b")).rejects.toThrow(
      "changed",
    );
    const provenance = {
      creative_brief_id: id,
      creative_brief_revision: 2,
      creative_concept_id: "concept-a",
    };
    await service.linkAsset(1, provenance, 22);
    await service.linkAsset(1, provenance, 11);
    await service.linkAsset(1, provenance, 11);
    const links = await client.query(
      "SELECT content_asset_id FROM ad_creative_brief_assets",
    );
    expect(links.rows).toEqual([{ content_asset_id: 11 }]);
  });
  it("rolls down without touching application tables", async () => {
    await down(client);
    expect(
      (await client.query("SELECT COUNT(*)::int AS count FROM users")).rows[0]
        .count,
    ).toBe(2);
    await up(client);
  });
});
