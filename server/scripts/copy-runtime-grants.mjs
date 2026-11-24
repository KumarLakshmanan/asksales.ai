#!/usr/bin/env node
/**
 * Re-apply the business runtime role's privileges to a restored database.
 *
 * A dump restored with pg_restore --no-acl / --no-privileges (common when copying a
 * production database to a developer machine) keeps every table but drops the grants
 * the migrations gave `salesmarketing_business_runtime`. Every application query runs
 * as that role, so the app fails until they are restored. This script copies them from
 * a database migrated to the same version.
 *
 * Usage (databases on the server configured by DB_HOST/DB_PORT/DB_USER/DB_PASSWORD,
 * loaded like the migration runner; MIGRATION credentials are used when set):
 *   node scripts/copy-runtime-grants.mjs --from salesmarketing --to salesmarketing_prod_copy
 *   node scripts/copy-runtime-grants.mjs --from <db> --to <db> --dry-run
 *
 * Only GRANT/REVOKE statements are run; no data is read or changed. Objects missing in
 * the target are skipped and reported.
 */

import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const ROLE = 'salesmarketing_business_runtime';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nodeEnv = process.env.NODE_ENV || 'development';
const explicit = Object.fromEntries(
  ['DB_USER', 'DB_PASSWORD', 'DB_HOST', 'DB_PORT', 'DB_SSL', 'DB_MIGRATION_USER', 'DB_MIGRATION_PASSWORD']
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
dotenv.config({ path: path.resolve(__dirname, '..', nodeEnv === 'production' ? '.env.production' : '.env.development') });
dotenv.config({ path: path.resolve(__dirname, '..', '.env'), override: true });
Object.assign(process.env, explicit);

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : undefined;
}

function client(database) {
  const migration = Boolean(process.env.DB_MIGRATION_USER || process.env.DB_MIGRATION_PASSWORD);
  return new pg.Client({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    user: (migration ? process.env.DB_MIGRATION_USER : process.env.DB_USER) || 'postgres',
    password: (migration ? process.env.DB_MIGRATION_PASSWORD : process.env.DB_PASSWORD) || '',
    database,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
}

/** GRANT/REVOKE statements that reproduce the runtime role's privileges in `source`. */
export async function runtimeGrantStatements(source) {
  const relations = await source.query(
    `SELECT format('GRANT %s ON %s %I.%I TO ${ROLE}',
              string_agg(DISTINCT a.privilege_type, ', ' ORDER BY a.privilege_type),
              CASE c.relkind WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, n.nspname, c.relname) AS statement,
            format('%I.%I', n.nspname, c.relname) AS object
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')
        AND a.grantee = '${ROLE}'::regrole
      GROUP BY n.nspname, c.relname, c.relkind
      ORDER BY c.relname`,
  );
  const functions = await source.query(
    `SELECT p.oid::regprocedure::text AS object,
            bool_or(a.grantee = '${ROLE}'::regrole AND a.privilege_type='EXECUTE') AS runtime,
            bool_or(a.grantee = 0 AND a.privilege_type='EXECUTE') AS public_execute
       FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
      WHERE p.pronamespace='public'::regnamespace AND p.proacl IS NOT NULL
      GROUP BY p.oid ORDER BY 1`,
  );
  const schema = await source.query(`SELECT has_schema_privilege('${ROLE}','public','USAGE') AS usage`);
  const statements = [];
  if (schema.rows[0]?.usage) statements.push({ kind: 'schema', object: 'public', sql: `GRANT USAGE ON SCHEMA public TO ${ROLE}` });
  for (const row of relations.rows) statements.push({ kind: 'relation', object: row.object, sql: row.statement });
  for (const row of functions.rows) {
    if (!row.public_execute) statements.push({ kind: 'function', object: row.object, sql: `REVOKE EXECUTE ON FUNCTION ${row.object} FROM PUBLIC` });
    if (row.runtime) statements.push({ kind: 'function', object: row.object, sql: `GRANT EXECUTE ON FUNCTION ${row.object} TO ${ROLE}` });
  }
  return statements;
}

async function exists(target, statement) {
  if (statement.kind === 'schema') return true;
  const check = statement.kind === 'function' ? 'to_regprocedure($1)' : 'to_regclass($1)';
  return (await target.query(`SELECT ${check} IS NOT NULL AS present`, [statement.object])).rows[0].present;
}

async function main() {
  const from = argument('from');
  const to = argument('to');
  const dryRun = process.argv.includes('--dry-run');
  if (!from || !to || from === to) {
    console.error('Usage: node scripts/copy-runtime-grants.mjs --from <migrated database> --to <restored database> [--dry-run]');
    process.exit(2);
  }
  const source = client(from);
  const target = client(to);
  await source.connect();
  await target.connect();
  try {
    const statements = await runtimeGrantStatements(source);
    const applicable = [];
    const skipped = [];
    for (const statement of statements) ((await exists(target, statement)) ? applicable : skipped).push(statement);
    console.log(`${statements.length} privilege statements from "${from}": ${applicable.length} apply to "${to}", ${skipped.length} skipped (object missing).`);
    for (const statement of skipped.slice(0, 10)) console.log(`  skipped: ${statement.object}`);
    if (dryRun) {
      console.log('Dry run: nothing changed.');
      return;
    }
    await target.query('BEGIN');
    for (const statement of applicable) await target.query(statement.sql);
    await target.query('COMMIT');
    const unreadable = await target.query(
      `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p')
          AND c.relname NOT IN ('__drizzle_migrations', 'js_migrations')
          AND (EXISTS(SELECT 1 FROM business_scope_tables b WHERE b.table_name=c.relname)
            OR EXISTS(SELECT 1 FROM business_scope_accounts a WHERE a.table_name=c.relname))
          AND NOT has_table_privilege('${ROLE}', c.oid, 'SELECT')`,
    );
    console.log(`Applied ${applicable.length} statements. Application tables still unreadable by ${ROLE}: ${unreadable.rows[0].n}.`);
  } catch (error) {
    await target.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await source.end();
    await target.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
