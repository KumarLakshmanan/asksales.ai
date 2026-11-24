import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { createBusinessScopedPool } from "../tenancy/scopedPool.js";
import { withBusinessScope } from "../tenancy/businessContext.js";
let database: NodePgDatabase;
const proxy = new Proxy({} as NodePgDatabase, {
  get(_target, key) {
    const value = database[key as keyof NodePgDatabase];
    return typeof value === "function" ? value.bind(database) : value;
  },
});
jest.unstable_mockModule("../models/db.js", () => ({ db: proxy }));
const removeObject = jest
  .fn<(...args: unknown[]) => Promise<void>>()
  .mockResolvedValue(undefined);
jest.unstable_mockModule("../services/ObjectStorageService.js", () => ({
  objectStorage: { delete: removeObject },
}));
jest.unstable_mockModule("../services/billing/entitlements.js", () => ({
  reserveOrganizationStorage: jest.fn(),
  releaseOrganizationStorage: jest.fn(),
  storageOrganizationEntitlements: jest.fn(),
}));
jest.unstable_mockModule("../utils/logger.js", () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
const { storageService } = await import("../services/StorageService.js");
const {
  actorFolders,
  workspaceFile,
  workspaceOverview,
  storageActivity,
  listWorkspaceFiles,
  mutateWorkspace,
  uploadWorkspaceFile,
  storageQuerySchema,
  storageMutationSchema,
} = await import("../services/storageWorkspace.js");
const migration = await import(
  // @ts-expect-error JavaScript migrations are executed by the custom runner.
  "../migrations/320_storage_workspace_indexes.js"
);
const profile = <T>(id: number, work: () => T) =>
  withBusinessScope(
    { userId: 9, businessProfileId: id, actorUserId: 99 },
    work,
  );
const query = (value = {}) => storageQuerySchema.parse(value);
const mutate = (action: string, fileIds: number[], extra = {}) =>
  profile(101, () =>
    mutateWorkspace(
      9,
      storageMutationSchema.parse({ action, fileIds, ...extra }),
    ),
  );
const local =
  process.env.STORAGE_WORKSPACE_LOCAL_QA === "1" ? describe : describe.skip;
local("storage workspace in isolated PostgreSQL", () => {
  let admin: Pool, fixture: Pool, runtime: Pool, schema: string;
  beforeAll(async () => {
    // Do not let saved application configuration retarget a destructive fixture.
    // The caller must provision and explicitly name a disposable local database.
    const url = new URL(process.env.STORAGE_WORKSPACE_QA_DATABASE_URL || "");
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
        !/^\/storage_audit(?:_[a-z0-9_]+)?$/.test(url.pathname))
      throw new Error("Storage QA requires an explicit disposable local storage_audit database");
    const connection = {
      connectionString: url.href,
      connectionTimeoutMillis: 5000,
    };
    schema = `storage_workspace_${randomBytes(8).toString("hex")}`;
    admin = new Pool({
      ...connection,
      max: 1,
      options: "-c search_path=pg_catalog",
    });
    await admin.query(`CREATE SCHEMA ${schema}`);
    fixture = new Pool({
      ...connection,
      max: 2,
      options: `-c search_path=${schema},pg_catalog`,
    });
    runtime = createBusinessScopedPool(
      new Pool({
        ...connection,
        max: 4,
        options: `-c search_path=${schema},pg_catalog`,
      }),
    );
    database = drizzle(runtime);
    await fixture.query(`CREATE TABLE company_settings(id integer PRIMARY KEY,user_id integer,company_name text,business_name text,name text,billing_organization_id integer DEFAULT 1);
      CREATE TABLE storage_files(id serial PRIMARY KEY,user_id integer NOT NULL,business_profile_id integer NOT NULL, file_name text NOT NULL,original_name text,storage_key text NOT NULL,storage_backend text DEFAULT 'local',mime_type text DEFAULT 'text/plain',file_size_bytes bigint DEFAULT 100,category text DEFAULT 'document',reference_type text,reference_id text,url text,metadata jsonb DEFAULT '{}',is_deleted boolean DEFAULT false,deleted_at timestamp,created_at timestamp DEFAULT now(),updated_at timestamp DEFAULT now());
      CREATE TABLE storage_quotas(id serial PRIMARY KEY,user_id integer,storage_used_bytes bigint,file_count integer,updated_at timestamp);
      CREATE TABLE billing_organizations(id integer PRIMARY KEY); INSERT INTO billing_organizations VALUES(1);
      CREATE TABLE storage_managed_references(user_id integer,business_profile_id integer,storage_file_id integer,storage_backend text,storage_key text);
      GRANT USAGE ON SCHEMA ${schema} TO salesmarketing_business_runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO salesmarketing_business_runtime; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO salesmarketing_business_runtime;`);
    for (const table of ["company_settings", "storage_files"]) {
      const column =
        table === "company_settings" ? "id" : "business_profile_id";
      await fixture.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
        CREATE POLICY fixture_isolation ON ${table} FOR ALL USING(current_user <> 'salesmarketing_business_runtime' OR (${column}=NULLIF(current_setting('app.business_profile_id',true),'')::int AND user_id=NULLIF(current_setting('app.current_user_id',true),'')::int)) WITH CHECK(current_user <> 'salesmarketing_business_runtime' OR (${column}=NULLIF(current_setting('app.business_profile_id',true),'')::int AND user_id=NULLIF(current_setting('app.current_user_id',true),'')::int));`);
    }
    await migration.up(fixture);
    await migration.up(fixture);
    jest.spyOn(storageService, "getUsageSummary").mockResolvedValue({
      storageUsedBytes: 5000,
      maxStorageBytes: 10000,
      fileCount: 5,
      usagePercent: 50,
      planName: "Free",
      breakdown: [],
    });
  }, 30000);
  afterAll(async () => {
    await runtime?.end();
    await fixture?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });
  beforeEach(async () => {
    removeObject.mockClear();
    await fixture.query(`TRUNCATE storage_files,company_settings,storage_quotas RESTART IDENTITY; INSERT INTO company_settings(id,user_id,company_name,business_name,name) VALUES(101,9,'Acme',null,null),(102,9,'Second',null,null),(201,19,'Other',null,null);
      INSERT INTO storage_files(id,user_id,business_profile_id,file_name,original_name,storage_key,category,reference_type) VALUES
      (1,9,101,'a.txt','Alpha.txt','9/document/a.txt','document','user_upload'),(2,9,101,'b.png','Beta.png','9/image/b.png','image','content_asset'),
      (3,9,102,'c.txt','Secret.txt','9/document/c.txt','document',null),(4,19,201,'d.txt','Foreign.txt','19/document/d.txt','document',null);
      INSERT INTO storage_quotas(user_id,storage_used_bytes,file_count) VALUES(9,300,3),(19,100,1); UPDATE storage_files SET created_at='2026-01-01'; SELECT setval('storage_files_id_seq',4);`);
  });
  it("isolates owners and profiles and traverses equal sort values without gaps or duplicates", async () => {
    const first = await profile(101, () =>
      listWorkspaceFiles(9, query({ limit: 1 })),
    );
    const second = await profile(101, () =>
      listWorkspaceFiles(9, query({ limit: 1, cursor: first.nextCursor })),
    );
    expect(first.total).toBe(2);
    expect([first.files[0].id, second.files[0].id]).toEqual([2, 1]);
    expect(second.nextCursor).toBeNull();
    await expect(profile(101, () => workspaceFile(9, 3))).rejects.toMatchObject(
      { status: 404 },
    );
    await expect(profile(201, () => workspaceFile(9, 4))).rejects.toMatchObject(
      { status: 404 },
    );
    await expect(
      profile(101, () =>
        listWorkspaceFiles(
          9,
          query({ cursor: first.nextCursor, search: "Alpha" }),
        ),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("keeps Trash charged, hides private content, restores metadata, and records the member who acted", async () => {
    await mutate("organize", [1], { tags: ["launch"], collection: "Campaign" });
    await mutate("trash", [1]);
    expect(
      (await profile(101, () => listWorkspaceFiles(9, query()))).files.map(
        (f) => f.id,
      ),
    ).toEqual([2]);
    await expect(profile(101, () => workspaceFile(9, 1))).rejects.toMatchObject(
      { status: 404 },
    );
    const overview = await profile(101, () => workspaceOverview(9));
    expect(overview).toMatchObject({
      activeCount: 1,
      trashCount: 1,
      trashBytes: 100,
      businessName: "Acme",
      storageUsedBytes: 5000,
    });
    expect(
      (
        await fixture.query(
          "SELECT storage_used_bytes FROM storage_quotas WHERE user_id=9",
        )
      ).rows[0].storage_used_bytes,
    ).toBe("300");
    await mutate("restore", [1]);
    const file = await profile(101, () => workspaceFile(9, 1));
    expect(file.metadata?.storageWorkspace).toMatchObject({
      tags: ["launch"],
      collection: "Campaign",
    });
    expect((await profile(101, () => storageActivity(9))).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "restore", actor_user_id: 99 }),
      ]),
    );
  });
  it("rolls back a mixed foreign batch and requires acknowledgement for linked resources", async () => {
    await expect(mutate("rename", [1], { name: "New.txt" })).resolves.toEqual({
      affected: 1,
    });
    await expect(
      mutate("trash", [1, 3], { acknowledgeReferences: true }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await profile(101, () => listWorkspaceFiles(9, query()))).total,
    ).toBe(2);
    await expect(mutate("trash", [2])).rejects.toMatchObject({ status: 409 });
    await mutate("trash", [2], { acknowledgeReferences: true });
  });
  it("purges once, reduces quota once, and rejects restoration after retention expires", async () => {
    await mutate("trash", [1]);
    await mutate("purge", [1]);
    expect(removeObject).toHaveBeenCalledTimes(1);
    expect(
      (
        await fixture.query(
          "SELECT storage_used_bytes,file_count FROM storage_quotas WHERE user_id=9",
        )
      ).rows[0],
    ).toEqual({ storage_used_bytes: "200", file_count: 2 });
    await expect(mutate("purge", [1])).rejects.toMatchObject({ status: 409 });
    await mutate("trash", [2], { acknowledgeReferences: true });
    await fixture.query(
      `UPDATE storage_files SET metadata=jsonb_set(metadata,'{storageWorkspace,trashedAt}',to_jsonb((now()-interval '31 days')::text)) WHERE id=2`,
    );
    await expect(mutate("restore", [2])).rejects.toMatchObject({ status: 409 });
    await profile(101, () => storageService.cleanupPendingObjects());
    expect(
      (await fixture.query("SELECT is_deleted FROM storage_files WHERE id=2"))
        .rows[0].is_deleted,
    ).toBe(true);
  });
  it("filters literal wildcard text, tags, collections, dates and size on the server", async () => {
    await mutate("rename", [1], { name: "50%_launch.txt" });
    await mutate("organize", [1], { tags: ["launch"], collection: "Q1" });
    const result = await profile(101, () =>
      listWorkspaceFiles(
        9,
        query({
          search: "%_",
          tag: "launch",
          collection: "Q1",
          after: "2026-01-01",
          before: "2026-01-01",
          minSize: 99,
          maxSize: 101,
        }),
      ),
    );
    expect(result.files.map((f) => f.id)).toEqual([1]);
  });
  it("aggregates entire actor runs before paginating files", async () => {
    await fixture.query(
      `INSERT INTO storage_files(user_id,business_profile_id,file_name,storage_key,category) SELECT 9,101,'out-'||n||'.json','9/actor_output/export/run-1/out-'||n||'.json','actor_output' FROM generate_series(10,79) n`,
    );
    expect(await profile(101, () => actorFolders(9))).toMatchObject({
      total: 1,
      folders: [{ folder: "export/run-1", count: 70, bytes: 7000 }],
    });
  });
  it("deduplicates concurrent retries across connections and rejects changed content under a receipt", async () => {
    await fixture.query(`SELECT setval('storage_files_id_seq',100)`);
    const upload = jest
      .spyOn(storageService, "upload")
      .mockImplementation(async (buffer, options) => {
        const result = await fixture.query(
          `INSERT INTO storage_files(user_id,business_profile_id,file_name,original_name,storage_key,metadata) VALUES(9,101,'upload.txt',$1,'9/document/upload.txt',$2::jsonb) RETURNING id`,
          [options.originalName, JSON.stringify(options.metadata)],
        );
        return {
          fileId: result.rows[0].id,
          fileName: "upload.txt",
          url: "",
          storageKey: "",
          fileSizeBytes: buffer.length,
        };
      });
    const file = {
      buffer: Buffer.from("same"),
      originalname: "upload.txt",
      mimetype: "text/plain",
    } as Express.Multer.File;
    const receipt = "4bd44c2b-34ec-49de-9e0c-47e73e534c61";
    const results = await Promise.all(
      Array.from({ length: 11 }, () =>
        profile(101, () => uploadWorkspaceFile(9, file, "document", receipt)),
      ),
    );
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(results[0].id).toBe(results[1].id);
    expect(results[0].workspace.uploadedByUserId).toBe(99);
    expect(upload).toHaveBeenCalledTimes(1);
    await expect(
      profile(101, () =>
        uploadWorkspaceFile(
          9,
          { ...file, buffer: Buffer.from("different") },
          "document",
          receipt,
        ),
      ),
    ).rejects.toMatchObject({ status: 409 });
    upload.mockRestore();
  });
  it("rejects malformed cursor values and uses a workspace index for selective profiles", async () => {
    await expect(
      profile(101, () =>
        listWorkspaceFiles(
          9,
          query({ cursor: Buffer.from("null").toString("base64url") }),
        ),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await fixture.query(
      `INSERT INTO storage_files(user_id,business_profile_id,file_name,storage_key,created_at) SELECT 9,1000+(n%200),'fixture.txt','9/document/'||n,now()-n*interval '1 minute' FROM generate_series(1,12000) n; ANALYZE storage_files`,
    );
    const plan = await fixture.query(
      `EXPLAIN (FORMAT JSON) SELECT id FROM storage_files WHERE business_profile_id=101 AND user_id=9 AND is_deleted=false AND metadata #>> '{storageWorkspace,trashedAt}' IS NULL ORDER BY created_at DESC,id DESC LIMIT 51`,
    );
    expect(JSON.stringify(plan.rows)).toMatch(
      /storage_workspace_(recent|size)_idx/,
    );
  });
  it("creates and removes only the workspace indexes", async () => {
    const indexes = await fixture.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND indexname LIKE 'storage_workspace_%'`,
      [schema],
    );
    expect(indexes.rows).toHaveLength(3);
    await migration.down(fixture);
    await migration.up(fixture);
  });
});
