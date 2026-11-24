import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import express from "express";
import request from "supertest";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Redis from "ioredis";
import net from "node:net";
import { createBusinessScopedPool } from "../tenancy/scopedPool.js";
import {
  withBusinessScope,
  withSystemScope,
} from "../tenancy/businessContext.js";
import { withBillingScope } from "../tenancy/billingContext.js";
import type {
  ManagedStorageObject,
  ManagedStorageTransaction,
} from "../services/managedStorageReferences.js";
let database: NodePgDatabase;
jest.unstable_mockModule("../models/db.js", () => ({
  db: new Proxy({} as NodePgDatabase, {
    get(_target, key) {
      const value = database[key as keyof NodePgDatabase];
      return typeof value === "function" ? value.bind(database) : value;
    },
  }),
}));
const local =
  process.env.STORAGE_MANAGED_LOCAL_QA === "1" ? describe : describe.skip;
const baseline = process.env.STORAGE_MANAGED_BASELINE === "1";
local(
  "managed references with real scoped PostgreSQL, HTTP and local bytes",
  () => {
    let admin: Pool,
      runtime: Pool,
      root: string,
      app: express.Express,
      owner: number,
      profile: number,
      other: number,
      payer: number,
      token: string;
    let service: (typeof import("../services/StorageService.js"))["storageService"];
    let objects: (typeof import("../services/ObjectStorageService.js"))["objectStorage"];
    let refs: typeof import("../services/managedStorageReferences.js");
    let cleanup: typeof import("../services/managedStorageCleanup.js");
    let migration: {
      up: (client: unknown) => Promise<void>;
      down: () => Promise<void>;
    };
    let closeRedis: () => Promise<void>;
    const duplicates: Redis[] = [];
    const blockedHosts: string[] = [];
    const scope = <T>(work: () => T) =>
      withBusinessScope(
        {
          userId: owner,
          businessProfileId: profile,
          actorUserId: owner,
          role: "owner",
        },
        () =>
          withBillingScope(
            {
              organizationId: payer,
              actorUserId: owner,
              businessProfileId: profile,
              businessOwnerUserId: owner,
            },
            work,
          ),
      );
    const ctx = () => ({ userId: owner, businessProfileId: profile });
    const tx = <T>(
      work: (transaction: ManagedStorageTransaction) => Promise<T>,
    ) => scope(() => database.transaction((transaction) => work(transaction)));
    const upload = (text = "synthetic managed bytes", extra = {}) =>
      scope(() =>
        service.upload(Buffer.from(text), {
          userId: owner,
          category: "brand_asset",
          originalName: "synthetic.txt",
          mimeType: "text/plain",
          ...extra,
        }),
      );
    async function identity(id: number): Promise<ManagedStorageObject> {
      const row = (
        await admin.query("SELECT * FROM storage_files WHERE id=$1", [id])
      ).rows[0];
      return {
        fileId: id,
        userId: row.user_id,
        businessProfileId: row.business_profile_id,
        storageBackend: row.storage_backend,
        storageKey: row.storage_key,
      };
    }
    const holder = (id: string) => ({ type: "brand_toolkit", id });
    const add = (id: string, object: ManagedStorageObject) =>
      tx((t) =>
        refs.setManagedStorageReferences(t, ctx(), holder(id), [object]),
      );
    const release = (id: string) =>
      tx((t) =>
        refs.releaseManagedStorageReferences(t, ctx(), holder(id), {
          cleanupReleased: true,
        }),
      );
    const call = (method: "get" | "post" | "put" | "delete", path: string) => {
      const api = request(app);
      return api[method](path)
        .set("Authorization", `Bearer ${token}`)
        .set("X-Business-Profile-Id", String(profile));
    };
    async function usage() {
      return (
        (
          await admin.query(
            "SELECT storage_used_bytes,file_count FROM storage_quotas WHERE user_id=$1",
            [owner],
          )
        ).rows[0] || { storage_used_bytes: "0", file_count: 0 }
      );
    }
    function gate() {
      let release!: () => void;
      const promise = new Promise<void>((r) => {
        release = r;
      });
      return { promise, release };
    }
    beforeAll(async () => {
      const url = new URL(process.env.STORAGE_AUDIT_DATABASE_URL || "");
      if (
        !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
        !/^\/storage_audit_bcs02(?:_before)?$/.test(url.pathname) ||
        process.env.REDIS_HOST !== "127.0.0.1" ||
        process.env.REDIS_PORT !== "56483"
      )
        throw Error(
          "Explicit disposable managed-storage database/Redis required",
        );
      const connect = net.Socket.prototype.connect;
      jest.spyOn(net.Socket.prototype, "connect").mockImplementation(function (
        this: net.Socket,
        ...args: unknown[]
      ) {
        const options = Array.isArray(args[0]) ? args[0][0] : args[0];
        const host =
          options && typeof options === "object"
            ? (options as { host?: string }).host
            : typeof args[1] === "string"
              ? args[1]
              : undefined;
        if (host && !["127.0.0.1", "localhost", "::1"].includes(host)) {
          blockedHosts.push(host);
          throw Error("Synthetic Storage test refused external socket");
        }
        return Reflect.apply(connect, this, args) as net.Socket;
      });
      admin = new Pool({ connectionString: url.href, max: 3 });
      runtime = createBusinessScopedPool(
        new Pool({ connectionString: url.href, max: 12 }),
      );
      database = drizzle(runtime);
      expect(
        (
          await admin.query("SELECT name FROM js_migrations WHERE name=$1", [
            baseline
              ? "320_storage_workspace_indexes.js"
              : "480_storage_managed_references.js",
          ])
        ).rowCount,
      ).toBe(1);
      root = await mkdtemp(join(tmpdir(), "storage-bcs02-objects-"));
      process.env.LOCAL_STORAGE_PATH = root;
      process.env.STORAGE_BACKEND = "local";
      process.env.JWT_SECRET = "storage-bcs02-synthetic-only-key";
      jest.spyOn(Redis.prototype, "duplicate").mockImplementation(function (
        this: Redis,
        options,
      ) {
        const connection = new Redis({ ...this.options, ...options });
        duplicates.push(connection);
        return connection;
      });
      ({ storageService: service } =
        await import("../services/StorageService.js"));
      ({ objectStorage: objects } =
        await import("../services/ObjectStorageService.js"));
      if (!baseline) {
        refs = await import("../services/managedStorageReferences.js");
        cleanup = await import("../services/managedStorageCleanup.js");
        const migrationPath = "../migrations/480_storage_managed_references.js";
        migration = await import(migrationPath);
      }
      const content = (await import("../routes/content.routes.js")).default;
      const { authenticateToken } = await import("../middleware/auth.js");
      const { deleteTemplate } =
        await import("../controllers/whatsappTemplateController.js");
      ({ closeRedisConnections: closeRedis } =
        await import("../infrastructure/redis.js"));
      app = express();
      app.use(express.json());
      const { responseWrapper } =
        await import("../middleware/responseWrapper.js");
      app.use("/api/settings", responseWrapper);
      app.use("/api/admin/storage", responseWrapper);
      app.use(
        "/api/settings",
        (await import("../routes/settings.routes.js")).default,
      );
      app.use("/api/content", content);
      const { authenticateAdminToken, requireSuperAdmin } =
        await import("../middleware/auth.js");
      const { adminDeleteFile, adminBulkDeleteFiles } =
        await import("../controllers/adminStorageController.js");
      app.delete(
        "/api/admin/storage/users/:userId/files/:fileId",
        authenticateAdminToken,
        requireSuperAdmin,
        adminDeleteFile,
      );
      app.post(
        "/api/admin/storage/users/:userId/files/bulk-delete",
        authenticateAdminToken,
        requireSuperAdmin,
        adminBulkDeleteFiles,
      );
      app.delete(
        "/api/whatsapp/templates/:id",
        authenticateToken,
        deleteTemplate,
      );
      app.use("/uploads", express.static(root));
    }, 30000);
    beforeEach(async () => {
      const user = await admin.query(
        "INSERT INTO users(email,name,is_verified,is_approved,is_setup_complete) VALUES($1,'Synthetic managed owner',true,true,true) RETURNING id",
        [`managed-${randomUUID()}@example.invalid`],
      );
      owner = Number(user.rows[0].id);
      const profiles = await admin.query(
        "INSERT INTO company_settings(user_id,company_name,is_default,is_approved) VALUES($1,'Synthetic Alpha',true,true),($1,'Synthetic Beta',false,true) RETURNING id,billing_organization_id",
        [owner],
      );
      [profile, other] = profiles.rows.map((row) => Number(row.id));
      payer = Number(profiles.rows[0].billing_organization_id);
      const { generateToken } = await import("../utils/jwt.js");
      token = generateToken({
        userId: owner,
        email: "managed@example.invalid",
      });
    });
    afterAll(async () => {
      jest.restoreAllMocks();
      for (const connection of duplicates) connection.disconnect();
      await closeRedis?.();
      await runtime?.end();
      await admin?.end();
      if (root) await rm(root, { recursive: true, force: true });
      expect(blockedHosts).toEqual([]);
    });
    it("preserves actual Brand A/B and an actual API-created frozen Content snapshot", async () => {
      const a = await call("post", "/api/content/brand-toolkits").send({
        name: "Synthetic A",
      });
      expect(a.status).toBe(201);
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      );
      const uploaded = await call(
        "post",
        `/api/content/brand-toolkits/${a.body.id}/logo`,
      ).attach("logo", png, {
        filename: "shared.png",
        contentType: "image/png",
      });
      expect(uploaded.status).toBe(200);
      const url = uploaded.body.url;
      const b = await call("post", "/api/content/brand-toolkits").send({
        name: "Synthetic B",
        logoUrl: url,
        logoUrls: [url],
      });
      expect(b.status).toBe(201);
      const frozen = await call("post", "/api/content/assets").send({
        type: "email",
        channel: "email",
        status: "draft",
        title: "Synthetic frozen content",
        content: "A synthetic note.",
        brandToolkitId: a.body.id,
      });
      expect({ status: frozen.status, error: frozen.body.error }).toEqual({
        status: 201,
        error: undefined,
      });
      if (!baseline) {
        // Actual writer hooks must enroll all three durable owners. Backfill
        // would hide a missing production registration in this combined case.
        const holders = (
          await admin.query(
            "SELECT r.reference_type,r.reference_id FROM storage_managed_references r JOIN storage_files f ON f.id=r.storage_file_id WHERE f.user_id=$1 AND f.url=$2",
            [owner, url],
          )
        ).rows;
        expect(holders).toHaveLength(3);
        expect(holders).toEqual(
          expect.arrayContaining([
            {
              reference_type: "brand_toolkit",
              reference_id: String(a.body.id),
            },
            {
              reference_type: "brand_toolkit",
              reference_id: String(b.body.id),
            },
            {
              reference_type: "content_asset",
              reference_id: String(frozen.body.id),
            },
          ]),
        );
      }
      const before = await usage();
      expect(
        (await call("delete", `/api/content/brand-toolkits/${a.body.id}`))
          .status,
      ).toBe(204);
      if (!baseline) {
        // The real Brand deletion already released A; repeating it is a no-op.
        expect(
          await tx((t) =>
            refs.releaseManagedStorageOwners(t, {
              owners: [
                { ...ctx(), kind: "brand_toolkit", id: String(a.body.id) },
              ],
              cleanupReleased: true,
            }),
          ),
        ).toEqual({ registered: 0, released: 0, cleanupFileIds: [] });
      }
      expect(
        (await call("get", `/api/content/brand-toolkits/${b.body.id}`)).body
          .logoUrl,
      ).toBe(url);
      const snapshot = (
        await admin.query(
          "SELECT brand_context_snapshot FROM content_assets WHERE id=$1",
          [frozen.body.id],
        )
      ).rows[0].brand_context_snapshot;
      expect(snapshot.brandToolkit.logoUrl).toBe(url);
      const retainedAfterA = await request(app).get(url);
      expect(retainedAfterA.status).toBe(200);
      expect(retainedAfterA.body).toEqual(png);
      expect(await usage()).toEqual(before);
      if (!baseline) {
        expect(
          (await call("delete", `/api/content/brand-toolkits/${b.body.id}`))
            .status,
        ).toBe(204);
        expect(
          await tx((t) =>
            refs.releaseManagedStorageOwners(t, {
              owners: [
                { ...ctx(), kind: "brand_toolkit", id: String(b.body.id) },
              ],
              cleanupReleased: true,
            }),
          ),
        ).toEqual({ registered: 0, released: 0, cleanupFileIds: [] });
        const retainedAfterB = await request(app).get(url);
        expect(retainedAfterB.status).toBe(200);
        expect(retainedAfterB.body).toEqual(png);
        expect(await usage()).toEqual(before);
        expect(
          (await call("delete", `/api/content/assets/${frozen.body.id}`))
            .status,
        ).toBe(200);
        // Content already released its holder with cleanup disabled. This
        // Brand-origin object remains a charged Storage-library file; asking
        // the removed holder to release again cannot create a cleanup intent.
        const remaining = (
          await admin.query(
            "SELECT id,storage_key,is_deleted,metadata FROM storage_files WHERE user_id=$1 AND url=$2",
            [owner, url],
          )
        ).rows[0];
        expect(remaining.is_deleted).toBe(false);
        expect(remaining.metadata.pendingCleanupKeys).toBeUndefined();
        expect(
          (
            await admin.query(
              "SELECT reference_type,reference_id FROM storage_managed_references WHERE user_id=$1 AND storage_file_id=$2",
              [owner, remaining.id],
            )
          ).rows,
        ).toEqual([]);
        expect(
          (
            await admin.query(
              "SELECT id FROM business_profile_asset_cleanup WHERE user_id=$1 AND storage_key=$2",
              [owner, remaining.storage_key],
            )
          ).rows,
        ).toEqual([]);
        const retainedAfterContent = await request(app).get(url);
        expect(retainedAfterContent.status).toBe(200);
        expect(retainedAfterContent.body).toEqual(png);
        expect(await usage()).toEqual(before);
        const library = await call(
          "get",
          "/api/settings/storage/workspace/files",
        ).query({ category: "brand_asset" });
        expect(library.status).toBe(200);
        expect(library.body.data.files).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: Number(remaining.id) }),
          ]),
        );
        const capacityUsed = async () =>
          Number(
            (
              await admin.query(
                "SELECT usage FROM billing_capacity_totals WHERE organization_id=$1 AND resource_key='storageBytes'",
                [payer],
              )
            ).rows[0]?.usage ?? 0,
          );
        expect(await capacityUsed()).toBe(png.length);

        // Explicit Storage deletion creates the durable intent. Fail its first
        // provider attempt, then prove committed intent/accounting before retry.
        const remove = jest
          .spyOn(objects, "delete")
          .mockRejectedValueOnce(
            new Error("synthetic last-reference provider unavailable"),
          );
        const claims = jest.spyOn(service, "claimFileDeletion");
        try {
          expect(
            (
              await call(
                "delete",
                `/api/settings/storage/files/${remaining.id}`,
              )
            ).status,
          ).toBe(200);
          const claimedFileIds = (
            await Promise.all(
              claims.mock.results
                .filter((result) => result.type === "return")
                .map((result) => result.value),
            )
          )
            .filter((file) => file !== null)
            .map((file) => file.id);
          expect(claimedFileIds.length).toBe(1);
          expect(claimedFileIds).toEqual([Number(remaining.id)]);
          const committed = (
            await admin.query(
              "SELECT is_deleted,metadata->'pendingCleanupKeys' AS pending FROM storage_files WHERE id=$1 AND user_id=$2",
              [remaining.id, owner],
            )
          ).rows[0];
          expect(committed).toEqual({
            is_deleted: true,
            pending: [remaining.storage_key],
          });
          expect(await usage()).toMatchObject({
            storage_used_bytes: "0",
            file_count: 0,
          });
          expect(await capacityUsed()).toBe(0);
          const deferredBytes = await request(app).get(url);
          expect(deferredBytes.status).toBe(200);
          expect(deferredBytes.body).toEqual(png);
          expect(remove).toHaveBeenCalledTimes(1);
          expect(
            await scope(() =>
              service.flushManagedStorageCleanup(ctx(), claimedFileIds),
            ),
          ).toEqual({ processed: 1, remaining: 0 });
          expect(remove).toHaveBeenCalledTimes(2);
          const providerOutcomes = await Promise.allSettled(
            remove.mock.results
              .filter((result) => result.type === "return")
              .map((result) => result.value),
          );
          expect(providerOutcomes.map((result) => result.status)).toEqual([
            "rejected",
            "fulfilled",
          ]);
          expect((await request(app).get(url)).status).toBe(404);
          expect(await usage()).toMatchObject({
            storage_used_bytes: "0",
            file_count: 0,
          });
          expect(await capacityUsed()).toBe(0);
          const deleted = (
            await admin.query(
              "SELECT is_deleted,metadata FROM storage_files WHERE id=$1",
              [remaining.id],
            )
          ).rows[0];
          expect(deleted.is_deleted).toBe(true);
          expect(deleted.metadata.pendingCleanupKeys).toBeUndefined();
          expect(
            (
              await call(
                "delete",
                `/api/settings/storage/files/${remaining.id}`,
              )
            ).status,
          ).toBe(404);
          expect(await scope(() => service.cleanupPendingObjects())).toEqual({
            processed: 0,
            remaining: 0,
          });
          expect(remove).toHaveBeenCalledTimes(2);
          expect(
            await scope(() =>
              service.flushManagedStorageCleanup(ctx(), claimedFileIds),
            ),
          ).toEqual({ processed: 0, remaining: 0 });
          expect(await usage()).toMatchObject({
            storage_used_bytes: "0",
            file_count: 0,
          });
          expect(await capacityUsed()).toBe(0);
        } finally {
          claims.mockRestore();
          remove.mockRestore();
        }
      }
    }, 30000);
    it("enlists the caller transaction and releases capacity only at the final reference", async () => {
      const f = await upload(),
        object = await identity(f.fileId);
      await add("one", object);
      await add("two", object);
      expect((await add("one", object)).registered).toBe(0);
      const before = await usage();
      expect((await release("one")).cleanupFileIds).toEqual([]);
      expect(await usage()).toEqual(before);
      const last = await release("two");
      expect(last.cleanupFileIds).toEqual([f.fileId]);
      expect(await usage()).toMatchObject({
        storage_used_bytes: "0",
        file_count: 0,
      });
      expect((await release("two")).cleanupFileIds).toEqual([]);
      expect(
        await scope(() =>
          service.flushManagedStorageCleanup(ctx(), last.cleanupFileIds),
        ),
      ).toEqual({ processed: 1, remaining: 0 });
      expect(
        await scope(() =>
          service.flushManagedStorageCleanup(ctx(), last.cleanupFileIds),
        ),
      ).toEqual({ processed: 0, remaining: 0 });
    });
    it("preserves automatic cleanup but allows existing authenticated Storage revocation", async () => {
      const file = await upload("shared explicit revocation");
      const object = await identity(file.fileId);
      await add("explicit-a", object);
      await add("explicit-b", object);
      const before = await usage();
      expect(await scope(() => service.deleteByUrl(file.url, owner))).toBe(
        false,
      );
      expect(await usage()).toEqual(before);
      expect(
        (await request(app).get(new URL(file.url, "http://localhost").pathname))
          .status,
      ).toBe(200);
      const denied = await call(
        "delete",
        `/api/settings/storage/files/${file.fileId}`,
      ).set("X-Business-Profile-Id", String(other));
      expect(denied.status).toBe(404);
      expect(await usage()).toEqual(before);
      const revoked = await call(
        "delete",
        `/api/settings/storage/files/${file.fileId}`,
      );
      expect(revoked.status).toBe(200);
      expect(
        (
          await admin.query(
            "SELECT count(*) FROM storage_managed_references WHERE storage_file_id=$1",
            [file.fileId],
          )
        ).rows[0].count,
      ).toBe("0");
      expect(await usage()).toMatchObject({
        storage_used_bytes: "0",
        file_count: 0,
      });
      expect(
        (await request(app).get(new URL(file.url, "http://localhost").pathname))
          .status,
      ).toBe(404);
      await expect(add("too-late", object)).rejects.toMatchObject({
        code: "STORAGE_REFERENCE_CONFLICT",
      });
      expect(
        (await call("delete", `/api/settings/storage/files/${file.fileId}`))
          .status,
      ).toBe(404);
      expect(await usage()).toMatchObject({
        storage_used_bytes: "0",
        file_count: 0,
      });
    });
    it("preserves existing super-admin deletion authority and refuses ordinary principals", async () => {
      const first = await upload("administrator single revocation");
      const second = await upload("administrator bulk revocation");
      await add("admin-first", await identity(first.fileId));
      await add("admin-second", await identity(second.fileId));
      const { generateToken } = await import("../utils/jwt.js");
      const principal = async (role: string) => {
        const email = `managed-${randomUUID()}@example.invalid`;
        const id = Number(
          (
            await admin.query(
              "INSERT INTO admins(email,password,name,role) VALUES($1,'synthetic-unused-password','Synthetic admin',$2) RETURNING id",
              [email, role],
            )
          ).rows[0].id,
        );
        return generateToken({ adminId: id, email, role });
      };
      const ordinary = await principal("admin");
      const elevated = await principal("super_admin");
      const endpoint = `/api/admin/storage/users/${owner}/files/${first.fileId}`;
      expect(
        (
          await request(app)
            .delete(endpoint)
            .set("Authorization", `Bearer ${token}`)
        ).status,
      ).toBe(403);
      expect(
        (
          await request(app)
            .delete(endpoint)
            .set("Authorization", `Bearer ${ordinary}`)
        ).status,
      ).toBe(403);
      expect((await objects.download(first.storageKey)).toString()).toBe(
        "administrator single revocation",
      );
      expect(
        (
          await request(app)
            .delete(endpoint)
            .set("Authorization", `Bearer ${elevated}`)
        ).status,
      ).toBe(200);
      const bulk = await request(app)
        .post(`/api/admin/storage/users/${owner}/files/bulk-delete`)
        .set("Authorization", `Bearer ${elevated}`)
        .send({ fileIds: [second.fileId] });
      expect(bulk.status).toBe(200);
      expect(bulk.body.deletedCount).toBe(1);
      await expect(objects.download(first.storageKey)).rejects.toThrow();
      await expect(objects.download(second.storageKey)).rejects.toThrow();
      expect(await usage()).toMatchObject({
        storage_used_bytes: "0",
        file_count: 0,
      });
    });
    it("retains explicit bulk revocation intents through provider failure and retries once", async () => {
      const file = await upload("retry explicit revocation");
      await add("explicit-retry", await identity(file.fileId));
      const remove = jest
        .spyOn(objects, "delete")
        .mockRejectedValueOnce(new Error("synthetic object unavailable"));
      try {
        const revoked = await call(
          "post",
          "/api/settings/storage/files/bulk-delete",
        ).send({ fileIds: [file.fileId] });
        expect(revoked.status).toBe(200);
        expect(revoked.body.deletedCount).toBe(1);
        expect(await usage()).toMatchObject({
          storage_used_bytes: "0",
          file_count: 0,
        });
        expect((await objects.download(file.storageKey)).toString()).toBe(
          "retry explicit revocation",
        );
        await expect(
          add("revoked-before-provider-recovery", await identity(file.fileId)),
        ).rejects.toMatchObject({ code: "STORAGE_REFERENCE_CONFLICT" });
        expect(
          (
            await admin.query(
              "SELECT metadata->'pendingCleanupKeys' AS pending,is_deleted FROM storage_files WHERE id=$1",
              [file.fileId],
            )
          ).rows[0],
        ).toEqual({ pending: [file.storageKey], is_deleted: true });
        await scope(() => service.cleanupPendingObjects());
        await scope(() => service.cleanupPendingObjects());
        expect(remove).toHaveBeenCalledTimes(2);
        await expect(objects.download(file.storageKey)).rejects.toThrow();
        expect(await usage()).toMatchObject({
          storage_used_bytes: "0",
          file_count: 0,
        });
      } finally {
        remove.mockRestore();
      }
    });
    it("preserves governed Trash purge and existing 30-day expiry with registered holders", async () => {
      const purged = await upload("explicit trash purge");
      await add("trash-purge", await identity(purged.fileId));
      expect(
        (
          await call("post", "/api/settings/storage/workspace/actions").send({
            action: "trash",
            fileIds: [purged.fileId],
            acknowledgeReferences: true,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await call("post", "/api/settings/storage/workspace/actions").send({
            action: "purge",
            fileIds: [purged.fileId],
          })
        ).status,
      ).toBe(200);
      await expect(objects.download(purged.storageKey)).rejects.toThrow();
      const expired = await upload("expired trash");
      const retained = await upload("recent trash");
      await add("expired-holder", await identity(expired.fileId));
      await add("recent-holder", await identity(retained.fileId));
      for (const [file, days] of [
        [expired, 31],
        [retained, 29],
      ] as const) {
        expect(
          (
            await call("post", "/api/settings/storage/workspace/actions").send({
              action: "trash",
              fileIds: [file.fileId],
              acknowledgeReferences: true,
            })
          ).status,
        ).toBe(200);
        await tx((t) =>
          t.execute(sql`UPDATE storage_files SET metadata=jsonb_set(metadata,
          '{storageWorkspace,trashedAt}',to_jsonb((now()-(${days}::int*interval '1 day'))::text))
          WHERE id=${file.fileId}`),
        );
      }
      await withSystemScope("storage-managed synthetic expiry", () =>
        service.cleanupPendingObjects(),
      );
      await expect(objects.download(expired.storageKey)).rejects.toThrow();
      expect((await objects.download(retained.storageKey)).toString()).toBe(
        "recent trash",
      );
      expect(
        (
          await admin.query(
            "SELECT storage_file_id FROM storage_managed_references WHERE storage_file_id IN($1,$2)",
            [expired.fileId, retained.fileId],
          )
        ).rows.map((row) => Number(row.storage_file_id)),
      ).toEqual([retained.fileId]);
      expect(await usage()).toMatchObject({
        storage_used_bytes: String(Buffer.byteLength("recent trash")),
        file_count: 1,
      });
    });
    it("keeps cross-business public capabilities unresolved without claiming foreign preservation", async () => {
      const file = await upload("cross-business public capability");
      await add("source-owner", await identity(file.fileId));
      const otherPayer = Number(
        (
          await admin.query(
            "SELECT billing_organization_id FROM company_settings WHERE id=$1",
            [other],
          )
        ).rows[0].billing_organization_id,
      );
      const inOther = <T>(work: () => T) =>
        withBusinessScope(
          {
            userId: owner,
            businessProfileId: other,
            actorUserId: owner,
            role: "owner",
          },
          () =>
            withBillingScope(
              {
                organizationId: otherPayer,
                actorUserId: owner,
                businessProfileId: other,
                businessOwnerUserId: owner,
              },
              work,
            ),
        );
      await inOther(() =>
        database.transaction(async (t) => {
          expect(
            await refs.resolveManagedStorageUrls(
              t,
              { userId: owner, businessProfileId: other },
              [file.url],
            ),
          ).toEqual({ objects: [], unresolvedUrls: [file.url] });
          expect(
            await refs.syncManagedStorageReferences(t, {
              owner: {
                kind: "brand_toolkit",
                id: "foreign-public-holder",
                userId: owner,
                businessProfileId: other,
              },
              urls: [file.url],
            }),
          ).toEqual({ registered: 0, released: 0, cleanupFileIds: [] });
        }),
      );
      await expect(
        inOther(() =>
          database.transaction((t) =>
            refs.resolveManagedStorageUrls(
              t,
              { userId: owner, businessProfileId: other },
              [`/api/settings/storage/files/${file.fileId}/download`],
            ),
          ),
        ),
      ).rejects.toMatchObject({ code: "STORAGE_REFERENCE_CONFLICT" });
      expect(
        (await request(app).get(new URL(file.url, "http://localhost").pathname))
          .status,
      ).toBe(200);
      const removed = await release("source-owner");
      await scope(() =>
        service.flushManagedStorageCleanup(ctx(), removed.cleanupFileIds),
      );
      expect(
        (await request(app).get(new URL(file.url, "http://localhost").pathname))
          .status,
      ).toBe(404);
    });
    it("enrolls existing private links and JSON-encoded Content media in the backfill", async () => {
      const publicFile = await upload("existing encoded public media");
      const privateFile = await upload("existing private media", {
        category: "document",
      });
      const brand = await call("post", "/api/content/brand-toolkits").send({
        name: "Synthetic enrollment brand",
      });
      expect(brand.status).toBe(201);
      const asset = await call("post", "/api/content/assets").send({
        type: "email",
        channel: "email",
        status: "draft",
        title: "Synthetic existing media",
        content: JSON.stringify({ imageUrl: publicFile.url }),
        imageUrl: privateFile.url,
        brandToolkitId: brand.body.id,
      });
      expect(asset.status).toBe(201);
      const client = await admin.connect();
      try {
        await client.query("BEGIN");
        await migration.up(client);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      expect(
        (
          await admin.query(
            "SELECT storage_file_id FROM storage_managed_references WHERE user_id=$1 AND reference_type='content_asset' AND reference_id=$2 ORDER BY storage_file_id",
            [owner, String(asset.body.id)],
          )
        ).rows.map((row) => Number(row.storage_file_id)),
      ).toEqual([publicFile.fileId, privateFile.fileId]);
      expect(
        await scope(() => service.deleteByUrl(publicFile.url, owner)),
      ).toBe(false);
      expect(
        await scope(() => service.deleteFile(privateFile.fileId, owner)),
      ).toBe(false);
    });
    it("retains a failed upload acquired by a concurrent durable reference writer", async () => {
      const file = await upload("concurrently acquired failed upload"),
        object = await identity(file.fileId);
      const entered = gate(),
        finish = gate(),
        before = await usage();
      const writer = tx(async (t) => {
        await refs.syncManagedStorageReferences(t, {
          owner: { kind: "brand_toolkit", id: "compensation-winner", ...ctx() },
          urls: [file.url],
        });
        entered.release();
        await finish.promise;
      });
      await entered.promise;
      const compensation = scope(() =>
        service.compensateFailedUpload(ctx(), file.fileId),
      );
      finish.release();
      await writer;
      expect(await compensation).toBe(false);
      expect((await objects.download(object.storageKey)).toString()).toBe(
        "concurrently acquired failed upload",
      );
      expect(await usage()).toEqual(before);
      expect(
        await scope(() => service.compensateFailedUpload(ctx(), file.fileId)),
      ).toBe(false);
      const released = await tx((t) =>
        refs.releaseManagedStorageOwners(t, {
          owners: [
            { kind: "brand_toolkit", id: "compensation-winner", ...ctx() },
          ],
          cleanupReleased: true,
        }),
      );
      await scope(() =>
        service.flushManagedStorageCleanup(ctx(), released.cleanupFileIds),
      );
      expect(await usage()).toMatchObject({
        storage_used_bytes: "0",
        file_count: 0,
      });
    });
    it("rejects a late attachment after failed-upload compensation claimed deletion", async () => {
      const file = await upload("compensation wins first"),
        object = await identity(file.fileId),
        entered = gate(),
        finish = gate();
      const original = objects.delete.bind(objects);
      const remove = jest
        .spyOn(objects, "delete")
        .mockImplementationOnce(async (key) => {
          entered.release();
          await finish.promise;
          return original(key);
        });
      try {
        const compensation = scope(() =>
          service.compensateFailedUpload(ctx(), file.fileId),
        );
        await entered.promise;
        const late = add("compensation-late", object);
        finish.release();
        expect(await compensation).toBe(true);
        await expect(late).rejects.toMatchObject({
          code: "STORAGE_REFERENCE_CONFLICT",
        });
        await expect(objects.download(file.storageKey)).rejects.toThrow();
        expect(
          await scope(() => service.compensateFailedUpload(ctx(), file.fileId)),
        ).toBe(false);
        expect(await usage()).toMatchObject({
          storage_used_bytes: "0",
          file_count: 0,
        });
      } finally {
        finish.release();
        remove.mockRestore();
      }
    });
    it("serializes writer-before-delete and preserves bytes", async () => {
      const f = await upload(),
        object = await identity(f.fileId),
        entered = gate(),
        finish = gate();
      const writer = tx(async (t) => {
        await refs.setManagedStorageReferences(t, ctx(), holder("race"), [
          object,
        ]);
        entered.release();
        await finish.promise;
      });
      await entered.promise;
      const deletion = scope(() => service.deleteFile(f.fileId, owner));
      finish.release();
      await writer;
      expect(await deletion).toBe(false);
      expect((await objects.download(f.storageKey)).toString()).toBe(
        "synthetic managed bytes",
      );
    });
    it("serializes existing governed revocation after an in-flight reference writer", async () => {
      const file = await upload("governed concurrent revocation");
      const object = await identity(file.fileId),
        entered = gate(),
        finish = gate();
      const writer = tx(async (t) => {
        await refs.setManagedStorageReferences(
          t,
          ctx(),
          holder("governed-writer"),
          [object],
        );
        entered.release();
        await finish.promise;
      });
      await entered.promise;
      const revoked = scope(() =>
        service.deleteFile(file.fileId, owner, undefined, "storage_delete"),
      );
      finish.release();
      await writer;
      expect(await revoked).toBe(true);
      await expect(objects.download(file.storageKey)).rejects.toThrow();
      await expect(
        add("after-governed-revocation", object),
      ).rejects.toMatchObject({ code: "STORAGE_REFERENCE_CONFLICT" });
      expect(await usage()).toMatchObject({
        storage_used_bytes: "0",
        file_count: 0,
      });
    });
    it("serializes delete-before-writer and rejects a newly dangling reference", async () => {
      const f = await upload(),
        object = await identity(f.fileId),
        entered = gate(),
        finish = gate();
      const deletion = tx(async (t) => {
        expect(
          await service.claimFileDeletion(t, f.fileId, owner),
        ).not.toBeNull();
        entered.release();
        await finish.promise;
      });
      await entered.promise;
      const writer = add("late", object);
      finish.release();
      await deletion;
      await expect(writer).rejects.toMatchObject({
        code: "STORAGE_REFERENCE_CONFLICT",
      });
      await expect(
        tx((t) => refs.resolveManagedStorageUrls(t, ctx(), [f.url])),
      ).rejects.toMatchObject({ code: "STORAGE_REFERENCE_CONFLICT" });
    });
    it("rolls back reference replacement and rejects in-place mutation of a held revision", async () => {
      const old = await upload("old bytes", {
          storageKey: `${owner}/brand_asset/stable.txt`,
        }),
        object = await identity(old.fileId);
      await add("replace", object);
      const fresh = await upload("new bytes"),
        newObject = await identity(fresh.fileId),
        before = await usage();
      await expect(
        tx(async (t) => {
          await refs.setManagedStorageReferences(
            t,
            ctx(),
            holder("replace"),
            [newObject],
            { cleanupReleased: true },
          );
          throw Error("synthetic rollback");
        }),
      ).rejects.toThrow("synthetic rollback");
      expect(
        (
          await admin.query(
            "SELECT storage_file_id FROM storage_managed_references WHERE user_id=$1",
            [owner],
          )
        ).rows.map((row) => row.storage_file_id),
      ).toEqual([old.fileId]);
      expect(await usage()).toEqual(before);
      await expect(
        upload("replacement attempted", {
          storageKey: `${owner}/brand_asset/stable.txt`,
        }),
      ).rejects.toMatchObject({ code: "STORAGE_REFERENCE_CONFLICT" });
      expect((await objects.download(old.storageKey)).toString()).toBe(
        "old bytes",
      );
      expect(await usage()).toEqual(before);
      const changed = await tx((t) =>
        refs.setManagedStorageReferences(
          t,
          ctx(),
          holder("replace"),
          [newObject],
          { cleanupReleased: true },
        ),
      );
      expect(changed.cleanupFileIds).toEqual([old.fileId]);
    });
    it("serializes two removals and retries without double quota release", async () => {
      const f = await upload(),
        object = await identity(f.fileId);
      await add("left", object);
      await add("right", object);
      const results = await Promise.all([release("left"), release("right")]);
      expect(results.flatMap((result) => result.cleanupFileIds)).toEqual([
        f.fileId,
      ]);
      expect(await usage()).toMatchObject({
        storage_used_bytes: "0",
        file_count: 0,
      });
      const remove = jest
        .spyOn(objects, "delete")
        .mockRejectedValueOnce(Error("synthetic object failure"));
      try {
        expect(
          await scope(() =>
            service.flushManagedStorageCleanup(ctx(), [f.fileId]),
          ),
        ).toEqual({ processed: 0, remaining: 1 });
      } finally {
        remove.mockRestore();
      }
      expect(
        await scope(() =>
          service.flushManagedStorageCleanup(ctx(), [f.fileId]),
        ),
      ).toEqual({ processed: 1, remaining: 0 });
      expect(await usage()).toMatchObject({
        storage_used_bytes: "0",
        file_count: 0,
      });
    });
    it("retains a Data receipt for referenced objects and failed acknowledgment after actual deletion", async () => {
      const f = await upload(),
        object = await identity(f.fileId);
      await add("receipt", object);
      const receipt = (
        await admin.query(
          "INSERT INTO business_profile_asset_cleanup(user_id,storage_key,storage_backend) VALUES($1,$2,$3) RETURNING id",
          [owner, f.storageKey, "local"],
        )
      ).rows[0].id;
      let failAck = false;
      const consume = () =>
        scope(() =>
          cleanup.consumeManagedStorageCleanup({
            identity: {
              ownerUserId: owner,
              storageBackend: "local",
              storageKey: f.storageKey,
            },
            expectedNamespace: `${owner}/brand_asset/`,
            loadIntent: async (t) =>
              (
                await t.execute(
                  sql`SELECT id FROM business_profile_asset_cleanup WHERE id=${receipt} AND user_id=${owner} AND storage_key=${f.storageKey} AND storage_backend='local' FOR UPDATE`,
                )
              ).rows.length > 0,
            acknowledge: async (t) => {
              if (failAck) throw Error("synthetic acknowledgment failure");
              return (
                (
                  await t.execute(
                    sql`DELETE FROM business_profile_asset_cleanup WHERE id=${receipt} AND user_id=${owner} AND storage_key=${f.storageKey} AND storage_backend='local' RETURNING id`,
                  )
                ).rows.length > 0
              );
            },
          }),
        );
      expect((await consume()).status).toBe("referenced");
      expect(
        (
          await admin.query(
            "SELECT id FROM business_profile_asset_cleanup WHERE id=$1",
            [receipt],
          )
        ).rowCount,
      ).toBe(1);
      await release("receipt");
      failAck = true;
      expect((await consume()).status).toBe("deferred");
      await expect(objects.download(f.storageKey)).rejects.toThrow();
      expect(
        (
          await admin.query(
            "SELECT id FROM business_profile_asset_cleanup WHERE id=$1",
            [receipt],
          )
        ).rowCount,
      ).toBe(1);
      await expect(add("late", object)).rejects.toMatchObject({
        code: "STORAGE_REFERENCE_CONFLICT",
      });
      failAck = false;
      expect((await consume()).status).toBe("deleted");
      expect((await consume()).status).toBe("already_consumed");
      expect(await usage()).toMatchObject({
        storage_used_bytes: "0",
        file_count: 0,
      });
    });
    it("uses canonical aws/s3 object locks and refuses wrong-tenant identities", async () => {
      const f = await upload(),
        object = await identity(f.fileId),
        entered = gate(),
        finish = gate();
      const holding = tx(async (t) => {
        await refs.lockManagedStorageReferences(t, ctx());
        await refs.lockManagedStorageObjects(t, [
          { ...object, storageBackend: "aws" },
        ]);
        entered.release();
        await finish.promise;
      });
      await entered.promise;
      const key = `storage-object:${owner}:s3:${f.storageKey}`;
      try {
        expect(
          (
            await admin.query(
              "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
              [key],
            )
          ).rows[0].acquired,
        ).toBe(false);
      } finally {
        finish.release();
        await holding;
      }
      await expect(
        add("wrong", { ...object, businessProfileId: other }),
      ).rejects.toMatchObject({ code: "STORAGE_REFERENCE_CONFLICT" });
      expect(
        await tx((t) =>
          refs.resolveManagedStorageUrls(t, ctx(), [
            "https://external.example.invalid/public.png",
          ]),
        ),
      ).toEqual({
        objects: [],
        unresolvedUrls: ["https://external.example.invalid/public.png"],
      });
      await expect(
        scope(() =>
          refs.setManagedStorageReferences(
            database as unknown as ManagedStorageTransaction,
            ctx(),
            holder("not-transaction"),
            [object],
          ),
        ),
      ).rejects.toThrow("caller transaction");
    });
    it("preserves actual Content failed-attachment compensation and local WhatsApp template media deletion", async () => {
      const brand = await call("post", "/api/content/brand-toolkits").send({
        name: "Synthetic compensation brand",
      });
      expect(brand.status).toBe(201);
      const asset = await call("post", "/api/content/assets").send({
        type: "email",
        channel: "email",
        status: "draft",
        title: "Synthetic fail attach",
        content: "A note.",
        brandToolkitId: brand.body.id,
      });
      expect(asset.status).toBe(201);
      await admin.query(`CREATE OR REPLACE FUNCTION storage_bcs02_fail_attach() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic attachment persistence failure'; END $$;
    CREATE TRIGGER storage_bcs02_fail_attach BEFORE UPDATE OF image_urls ON content_assets FOR EACH ROW WHEN(OLD.title='Synthetic fail attach') EXECUTE FUNCTION storage_bcs02_fail_attach();`);
      const before = await usage();
      try {
        const png = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        );
        const failed = await call("post", "/api/content/assets/upload")
          .field("assetId", String(asset.body.id))
          .field("mediaType", "image")
          .attach("file", png, {
            filename: "compensated.png",
            contentType: "image/png",
          });
        expect(failed.status).toBe(500);
        expect(await usage()).toEqual(before);
      } finally {
        await admin.query(
          "DROP TRIGGER storage_bcs02_fail_attach ON content_assets; DROP FUNCTION storage_bcs02_fail_attach()",
        );
      }
      for (const category of ["brand_asset", "document"] as const) {
        const f = await upload("synthetic template media", { category });
        const template = (
          await scope(() =>
            database.execute(
              sql`INSERT INTO whatsapp_templates(user_id,business_profile_id,name,body,header_type,header_media_url) VALUES(${owner},${profile},${"synthetic_" + randomUUID().replaceAll("-", "")},'Synthetic body','DOCUMENT',${f.url}) RETURNING id`,
            ),
          )
        ).rows[0];
        const result = await call(
          "delete",
          `/api/whatsapp/templates/${template.id}`,
        );
        expect(result.status).toBe(200);
        expect(
          (
            await admin.query(
              "SELECT is_deleted FROM storage_files WHERE id=$1",
              [f.fileId],
            )
          ).rows[0].is_deleted,
        ).toBe(true);
        await expect(objects.download(f.storageKey)).rejects.toThrow();
      }
    });
    it("syncs distinct current/version holders atomically and batch-releases only their references", async () => {
      const f = await upload(),
        object = await identity(f.fileId),
        current = { ...ctx(), kind: "content_template" as const, id: "901" },
        version = {
          ...ctx(),
          kind: "content_template_version" as const,
          id: "902",
        };
      await tx(async (t) => {
        await refs.lockManagedStorageReferences(t, ctx());
        await refs.syncManagedStorageReferences(t, {
          owner: current,
          urls: [f.url],
        });
        await refs.syncManagedStorageReferences(t, {
          owner: version,
          urls: [f.url],
        });
      });
      expect(
        (
          await tx((t) =>
            refs.syncManagedStorageReferences(t, {
              owner: current,
              urls: [],
              cleanupReleased: true,
            }),
          )
        ).cleanupFileIds,
      ).toEqual([]);
      await expect(
        tx(async (t) => {
          await refs.syncManagedStorageReferences(t, {
            owner: { ...ctx(), kind: "content_asset", id: "903" },
            urls: [f.url],
          });
          throw Error("domain/history/receipt rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(
        (
          await admin.query(
            "SELECT reference_type FROM storage_managed_references WHERE user_id=$1",
            [owner],
          )
        ).rows.map((row) => row.reference_type),
      ).toEqual(["content_template_version"]);
      expect(
        (
          await tx((t) =>
            refs.releaseManagedStorageOwners(t, {
              owners: [current, version, version],
              cleanupReleased: true,
            }),
          )
        ).cleanupFileIds,
      ).toEqual([object.fileId]);
    });
    it("defers active or namespace-mismatched receipt cleanup without acknowledging it", async () => {
      const f = await upload();
      let acknowledged = false;
      const input = {
        identity: {
          ownerUserId: owner,
          storageBackend: "local",
          storageKey: f.storageKey,
        },
        expectedNamespace: `${owner}/brand_asset/`,
        loadIntent: async () => true,
        acknowledge: async () => {
          acknowledged = true;
          return true;
        },
      };
      expect(
        await scope(() => cleanup.consumeManagedStorageCleanup(input)),
      ).toMatchObject({ status: "deferred", reason: "active_object" });
      expect(
        await scope(() =>
          cleanup.consumeManagedStorageCleanup({
            ...input,
            expectedNamespace: `${owner}/document/`,
          }),
        ),
      ).toMatchObject({ status: "deferred", reason: "namespace_mismatch" });
      expect(acknowledged).toBe(false);
      expect((await objects.download(f.storageKey)).length).toBeGreaterThan(0);
    });
    it("rolls back existing-record enrollment with its migration transaction", async () => {
      const f = await upload();
      // Seed a genuine pre-enrollment row through the scoped runtime fixture.
      // Current Brand POST atomically registers references and cannot represent
      // legacy data. Keep its production hooks and the database guards intact.
      const legacy = await tx((t) =>
        t.execute(sql`INSERT INTO brand_toolkits
        (user_id,business_profile_id,name,logo_url)
        VALUES(${owner},${profile},'Synthetic backfill rollback',${f.url}) RETURNING id`),
      );
      expect(legacy.rows).toHaveLength(1);
      const before = (
        await admin.query(
          "SELECT count(*) FROM storage_managed_references WHERE user_id=$1",
          [owner],
        )
      ).rows[0].count;
      const c = await admin.connect();
      await c.query("BEGIN");
      try {
        await migration.up(c);
        expect(
          Number(
            (
              await c.query(
                "SELECT count(*) FROM storage_managed_references WHERE user_id=$1",
                [owner],
              )
            ).rows[0].count,
          ),
        ).toBeGreaterThan(Number(before));
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
      expect(
        (
          await admin.query(
            "SELECT count(*) FROM storage_managed_references WHERE user_id=$1",
            [owner],
          )
        ).rows[0].count,
      ).toBe(before);
    });
    it("enrolls actual template versions independently from a changed current snapshot", async () => {
      const first = await upload("original historical logo"),
        second = await upload("current logo");
      const a = await call("post", "/api/content/brand-toolkits").send({
        name: "Historical brand",
        logoUrl: first.url,
      });
      const b = await call("post", "/api/content/brand-toolkits").send({
        name: "Current brand",
        logoUrl: second.url,
      });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      const created = await call("post", "/api/content/templates").send({
        name: "Synthetic versioned template",
        type: "email",
        content: "Original note.",
        brandToolkitId: a.body.id,
      });
      expect(created.status).toBe(201);
      const updated = await call(
        "put",
        `/api/content/templates/${created.body.id}`,
      ).send({ content: "Updated note.", brandToolkitId: b.body.id });
      expect(updated.status).toBe(200);
      const versions = (
        await admin.query(
          "SELECT id,snapshot FROM content_template_versions WHERE template_id=$1 ORDER BY version",
          [created.body.id],
        )
      ).rows;
      expect(versions.length).toBe(2);
      expect(
        versions[0].snapshot.brandContextSnapshot.brandToolkit.logoUrl,
      ).toBe(first.url);
      const c = await admin.connect();
      await c.query("BEGIN");
      try {
        await migration.up(c);
        await c.query("COMMIT");
      } catch (error) {
        await c.query("ROLLBACK");
        throw error;
      } finally {
        c.release();
      }
      const enrolled = (
        await admin.query(
          "SELECT reference_type,reference_id,storage_file_id FROM storage_managed_references WHERE user_id=$1",
          [owner],
        )
      ).rows;
      expect(enrolled).toEqual(
        expect.arrayContaining([
          {
            reference_type: "content_template_version",
            reference_id: String(versions[0].id),
            storage_file_id: first.fileId,
          },
        ]),
      );
      await tx((t) =>
        refs.releaseManagedStorageOwners(t, {
          owners: [{ ...ctx(), kind: "brand_toolkit", id: String(a.body.id) }],
          cleanupReleased: true,
        }),
      );
      expect(await scope(() => service.deleteByUrl(first.url, owner))).toBe(
        false,
      );
      expect((await objects.download(first.storageKey)).toString()).toBe(
        "original historical logo",
      );
    });
    it("consumes a surviving Data receipt in system scope after storage metadata removal", async () => {
      const file = await upload(),
        object = await identity(file.fileId);
      await tx((t) => service.claimFileDeletion(t, file.fileId, owner));
      const receipt = (
        await admin.query(
          "INSERT INTO business_profile_asset_cleanup(user_id,storage_key,storage_backend) VALUES($1,$2,'local') RETURNING id",
          [owner, file.storageKey],
        )
      ).rows[0].id;
      await scope(() =>
        database.execute(
          sql`DELETE FROM storage_files WHERE id=${file.fileId} AND user_id=${owner}`,
        ),
      );
      await expect(add("missing-metadata", object)).rejects.toMatchObject({
        code: "STORAGE_REFERENCE_CONFLICT",
      });
      const result = await withSystemScope(
        "Consume one synthetic surviving object receipt",
        () =>
          cleanup.consumeManagedStorageCleanup({
            identity: {
              ownerUserId: owner,
              storageBackend: "local",
              storageKey: file.storageKey,
            },
            expectedNamespace: `${owner}/brand_asset/`,
            loadIntent: async (t) =>
              (
                await t.execute(
                  sql`SELECT id FROM business_profile_asset_cleanup WHERE id=${receipt} AND user_id=${owner} AND storage_key=${file.storageKey} AND storage_backend='local' FOR UPDATE`,
                )
              ).rows.length > 0,
            acknowledge: async (t) =>
              (
                await t.execute(
                  sql`DELETE FROM business_profile_asset_cleanup WHERE id=${receipt} AND user_id=${owner} AND storage_key=${file.storageKey} AND storage_backend='local' RETURNING id`,
                )
              ).rows.length > 0,
          }),
      );
      expect(result.status).toBe("deleted");
      await expect(objects.download(file.storageKey)).rejects.toThrow();
      expect(await usage()).toMatchObject({
        storage_used_bytes: "0",
        file_count: 0,
      });
    });
    it("enforces raw ledger isolation for another business and another tenant", async () => {
      expect(
        (await scope(() => database.execute(sql`SELECT current_user AS role`)))
          .rows[0].role,
      ).toBe("salesmarketing_business_runtime");
      const foreignUser = Number(
        (
          await admin.query(
            "INSERT INTO users(email,name,is_verified,is_approved,is_setup_complete) VALUES($1,'Synthetic foreign owner',true,true,true) RETURNING id",
            [`foreign-${randomUUID()}@example.invalid`],
          )
        ).rows[0].id,
      );
      const foreignProfile = (
        await admin.query(
          "INSERT INTO company_settings(user_id,company_name,is_default,is_approved) VALUES($1,'Synthetic foreign business',true,true) RETURNING id,billing_organization_id",
          [foreignUser],
        )
      ).rows[0];
      const otherOrg = Number(
        (
          await admin.query(
            "SELECT billing_organization_id FROM company_settings WHERE id=$1",
            [other],
          )
        ).rows[0].billing_organization_id,
      );
      for (const target of [
        { userId: owner, businessProfileId: other, organizationId: otherOrg },
        {
          userId: foreignUser,
          businessProfileId: Number(foreignProfile.id),
          organizationId: Number(foreignProfile.billing_organization_id),
        },
      ]) {
        const run = <T>(work: () => T) =>
          withBusinessScope(
            { ...target, actorUserId: target.userId, role: "owner" },
            () =>
              withBillingScope(
                {
                  organizationId: target.organizationId,
                  actorUserId: target.userId,
                  businessProfileId: target.businessProfileId,
                  businessOwnerUserId: target.userId,
                },
                work,
              ),
          );
        const file = await run(() =>
          service.upload(Buffer.from("foreign bytes"), {
            userId: target.userId,
            category: "brand_asset",
            originalName: "foreign.txt",
            mimeType: "text/plain",
          }),
        );
        const object: ManagedStorageObject = {
          fileId: file.fileId,
          userId: target.userId,
          businessProfileId: target.businessProfileId,
          storageBackend: "local",
          storageKey: file.storageKey,
        };
        await run(() =>
          database.transaction((t) =>
            refs.setManagedStorageReferences(
              t,
              target,
              { type: "brand_toolkit", id: "foreign" },
              [object],
            ),
          ),
        );
        expect(
          (
            await scope(() =>
              database.execute(
                sql`SELECT * FROM storage_managed_references WHERE storage_file_id=${file.fileId}`,
              ),
            )
          ).rows,
        ).toEqual([]);
        await expect(
          scope(() =>
            database.execute(
              sql`INSERT INTO storage_managed_references(user_id,business_profile_id,reference_type,reference_id,storage_file_id,storage_backend,storage_key) VALUES(${target.userId},${target.businessProfileId},'brand_toolkit','injected',${file.fileId},'local',${file.storageKey})`,
            ),
          ),
        ).rejects.toThrow();
        expect((await objects.download(file.storageKey)).toString()).toBe(
          "foreign bytes",
        );
      }
    });
    it("prelocks attempt-first batches and preserves edges transferred to surviving history", async () => {
      const a = await upload("old bytes", { originalName: "a.txt" }),
        b = await upload("new bytes", { originalName: "z.txt" });
      const current = { ...ctx(), kind: "content_asset" as const, id: "501" },
        attempt = {
          ...ctx(),
          kind: "social_publish_attempt" as const,
          id: "502",
        };
      await tx((t) =>
        refs.syncManagedStorageReferences(t, { owner: current, urls: [a.url] }),
      );
      const changed = await tx((t) =>
        refs.syncManagedStorageOwners(t, {
          entries: [
            { owner: attempt, urls: [b.url] },
            { owner: current, urls: [b.url] },
          ],
        }),
      );
      expect(changed.released).toBe(1);
      const transfer = await tx((t) =>
        refs.syncManagedStorageOwners(t, {
          entries: [
            { owner: current, urls: [b.url] },
            { owner: attempt, urls: [a.url] },
          ],
          cleanupReleased: true,
        }),
      );
      expect(transfer.cleanupFileIds).toEqual([]);
      expect((await objects.download(a.storageKey)).toString()).toBe(
        "old bytes",
      );
      expect((await objects.download(b.storageKey)).toString()).toBe(
        "new bytes",
      );
      expect(
        (
          await tx((t) =>
            refs.releaseManagedStorageOwners(t, {
              owners: [current],
              cleanupReleased: true,
            }),
          )
        ).cleanupFileIds,
      ).toEqual([b.fileId]);
      expect(
        (
          await admin.query(
            "SELECT reference_type,storage_file_id FROM storage_managed_references WHERE user_id=$1",
            [owner],
          )
        ).rows,
      ).toEqual([
        { reference_type: "social_publish_attempt", storage_file_id: a.fileId },
      ]);
    });
    it("keeps new schema scoped and refuses destructive ledger rollback", async () => {
      const { assertBusinessScopeSchema } =
        await import("../tenancy/schemaGuard.js");
      await expect(assertBusinessScopeSchema(admin)).resolves.toBeUndefined();
      await expect(migration.down()).rejects.toThrow("coordinated rollback");
    });
  },
);
