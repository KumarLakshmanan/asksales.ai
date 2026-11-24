/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { Pool } from "pg";
import {
  mkdtemp,
  mkdir,
  copyFile,
  writeFile,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
// @ts-expect-error Custom JavaScript migration.
import * as importMigration from "../migrations/330_crm_import_recovery.js";
// @ts-expect-error Custom JavaScript migration.
import * as hotelMigration from "../migrations/331_hotel_room_import_identity.js";
const local =
  process.env.DATA_INTEGRITY_LOCAL_QA === "1" ? describe : describe.skip;
local("data integrity migration acceptance on disposable PostgreSQL", () => {
  const schema = "integrity_migration_" + randomBytes(6).toString("hex");
  const pool = new Pool({
    host: "127.0.0.1",
    port: 55437,
    user: "postgres",
    database: "implementation_synthetic",
    max: 2,
    options: `-c search_path=${schema},pg_catalog`,
  });
  let directory: string;
  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA ${schema}`);
    directory = await mkdtemp(join(tmpdir(), "integrity-migrations-"));
    await mkdir(join(directory, "scripts"));
    await mkdir(join(directory, "migrations"));
    await copyFile(
      resolve("scripts/migrate.mjs"),
      join(directory, "scripts/migrate.mjs"),
    );
    await symlink(
      resolve("node_modules"),
      join(directory, "node_modules"),
      "dir",
    );
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    await writeFile(
      join(directory, "migrations/001_synthetic.js"),
      "export async function up(c){await c.query('CREATE TABLE synthetic_migration_state(value integer)');} export async function down(c){await c.query('DROP TABLE synthetic_migration_state');}",
    );
  });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  });
  const invoke = async (...args: string[]) => {
    const url = new URL(
      "postgresql://postgres@127.0.0.1:55437/implementation_synthetic",
    );
    url.searchParams.set("options", `-c search_path=${schema},pg_catalog`);
    try {
      const value = await promisify(execFile)(
        process.execPath,
        [join(directory, "scripts/migrate.mjs"), ...args],
        {
          env: {
            PATH: process.env.PATH,
            HOME: tmpdir(),
            NODE_ENV: "test",
            MIGRATION_DATABASE_URL: url.toString(),
            NODE_OPTIONS: process.env.NODE_OPTIONS,
          },
        },
      );
      return { code: 0, ...value };
    } catch (error) {
      const e = error as any;
      return { code: e.code, stdout: e.stdout, stderr: e.stderr };
    }
  };
  it("up, down and ledger mutation refuse an occupied migration lock and preserve state", async () => {
    expect((await invoke("up")).code).toBe(0);
    const client = await pool.connect();
    await client.query("SELECT pg_advisory_lock(8623)");
    try {
      for (const args of [
        ["up"],
        ["down"],
        ["mark-applied", "001_synthetic.js"],
      ])
        expect((await invoke(...args)).code).toBe(2);
      expect(
        (await pool.query("SELECT count(*)::int n FROM js_migrations")).rows[0]
          .n,
      ).toBe(1);
      expect(
        (
          await pool.query(
            "SELECT to_regclass('synthetic_migration_state') AS t",
          )
        ).rows[0].t,
      ).not.toBeNull();
    } finally {
      await client.query("SELECT pg_advisory_unlock(8623)");
      client.release();
    }
    expect((await invoke("down")).code).toBe(0);
    expect(
      (await pool.query("SELECT count(*)::int n FROM js_migrations")).rows[0].n,
    ).toBe(0);
  });
  it("import recovery migration is repeatable/reversible and refuses historical duplicate receipts", async () => {
    await pool.query(
      "CREATE TABLE crm_contact_imports(id serial PRIMARY KEY,business_profile_id integer,user_id integer); CREATE TABLE crm_contact_import_details(import_id integer,row_number integer,status text); INSERT INTO crm_contact_imports VALUES(1,101,9); INSERT INTO crm_contact_import_details VALUES(1,2,'success'),(1,2,'success')",
    );
    await expect(importMigration.up(pool)).rejects.toThrow(
      "Duplicate import row receipts",
    );
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM information_schema.columns WHERE table_schema=$1 AND table_name='crm_contact_imports' AND column_name='request_fingerprint'",
          [schema],
        )
      ).rows[0].n,
    ).toBe(0);
    // Delete only our disposable duplicate fixture, never application history.
    await pool.query(
      "TRUNCATE crm_contact_import_details; INSERT INTO crm_contact_import_details VALUES(1,2,'success')",
    );
    await importMigration.up(pool);
    await importMigration.up(pool);
    expect(
      (await pool.query("SELECT processed_records FROM crm_contact_imports"))
        .rows[0].processed_records,
    ).toBe(1);
    await expect(
      pool.query(
        "INSERT INTO crm_contact_import_details VALUES(1,2,'success')",
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await importMigration.down(pool);
    await importMigration.up(pool);
  });
  it("room identity migration refuses duplicates without changing inventory and enforces new uniqueness", async () => {
    await pool.query(
      "CREATE TABLE room_types(id serial PRIMARY KEY,hotel_id integer,name text); INSERT INTO room_types(hotel_id,name) VALUES(1,'Deluxe'),(1,'Deluxe')",
    );
    await expect(hotelMigration.up(pool)).rejects.toThrow("owner review");
    expect(
      (await pool.query("SELECT count(*)::int n FROM room_types")).rows[0].n,
    ).toBe(2);
    await pool.query(
      "TRUNCATE room_types; INSERT INTO room_types(hotel_id,name) VALUES(1,'Deluxe')",
    );
    await hotelMigration.up(pool);
    await hotelMigration.up(pool);
    await expect(
      pool.query("INSERT INTO room_types(hotel_id,name) VALUES(1,'Deluxe')"),
    ).rejects.toMatchObject({ code: "23505" });
    await hotelMigration.down(pool);
    await hotelMigration.up(pool);
  });
});
