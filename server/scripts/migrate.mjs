#!/usr/bin/env node
/**
 * Migration runner for JS-based migrations in server/migrations/
 *
 * Usage:
 *   node scripts/migrate.mjs status          - Show applied / pending migrations
 *   node scripts/migrate.mjs up [name]       - Run all pending migrations, or one named migration
 *   node scripts/migrate.mjs down            - Rollback the latest batch
 *   node scripts/migrate.mjs mark-applied <name>  - Mark a migration as applied without running it
 *   node scripts/migrate.mjs create <name>   - Scaffold a new migration file
 */

import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use the same environment selection as the application. Loading production
// after development would silently point local migration commands at the
// production-configured database.
const nodeEnv = process.env.NODE_ENV || 'development';
const envFile = nodeEnv === 'production' ? '.env.production' : '.env.development';
const explicitDatabaseEnvironment = Object.fromEntries(
  [
    'DATABASE_URL',
    'MIGRATION_DATABASE_URL',
    'DB_MIGRATION_USER',
    'DB_MIGRATION_PASSWORD',
    'DB_USER',
    'DB_PASSWORD',
    'DB_HOST',
    'DB_PORT',
    'DB_NAME',
    'DB_DATABASE',
    'DB_SSL',
  ]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
dotenv.config({ path: path.resolve(__dirname, '..', envFile) });
dotenv.config({ path: path.resolve(__dirname, '..', '.env'), override: true });
Object.assign(process.env, explicitDatabaseEnvironment);

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');
const TRACKING_TABLE = 'js_migrations';

function getPool() {
  const hasMigrationCredential = Boolean(process.env.DB_MIGRATION_USER || process.env.DB_MIGRATION_PASSWORD);
  const user = hasMigrationCredential ? process.env.DB_MIGRATION_USER : process.env.DB_USER;
  const password = hasMigrationCredential ? process.env.DB_MIGRATION_PASSWORD : process.env.DB_PASSWORD;
  const connectionString = process.env.MIGRATION_DATABASE_URL
    || (!hasMigrationCredential && process.env.DATABASE_URL);
  // Structured fields preserve reserved password characters without logging a URI.
  const target = connectionString ? { connectionString } : {
    host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432),
    user: user || 'postgres', password: password || '',
    database: process.env.DB_NAME || process.env.DB_DATABASE || 'salesmarketing',
    ssl: process.env.DB_SSL === 'true',
  };
  return new pg.Pool({ ...target, connectionTimeoutMillis: 10_000,
    statement_timeout: 300_000, lock_timeout: 15_000 });
}

async function ensureTrackingTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
      id      SERIAL PRIMARY KEY,
      name    VARCHAR(255) NOT NULL UNIQUE,
      batch   INTEGER NOT NULL DEFAULT 1,
      run_on  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function trackingTableExists(client) {
  const { rows } = await client.query(`SELECT to_regclass('public.${TRACKING_TABLE}') AS table_name`);
  return Boolean(rows[0]?.table_name);
}

async function getAppliedMigrations(client) {
  const { rows } = await client.query(`SELECT name, batch FROM ${TRACKING_TABLE} ORDER BY id`);
  return rows;
}

function getMigrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.js'))
    .sort();
}

// All schema and tracking-ledger writes share the same session lock.
async function acquireMigrationLock(client) {
  const result = await client.query('SELECT pg_try_advisory_lock(8623) AS got');
  if (result.rows[0]?.got === true) return true;
  console.error('Another migration is already running (advisory lock 8623 held).');
  process.exitCode = 2;
  return false;
}

// ── Commands ────────────────────────────────────────────────────────────────────

async function status() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    // Inspection must never create schema, even on a brand-new database.
    const applied = await trackingTableExists(client) ? await getAppliedMigrations(client) : [];
    const appliedNames = new Set(applied.map(r => r.name));
    const files = getMigrationFiles();

    console.log('\n  Migration Status\n  ────────────────');
    for (const f of files) {
      const marker = appliedNames.has(f) ? '✓' : '✗ (pending)';
      console.log(`  ${marker}  ${f}`);
    }
    const pending = files.filter(f => !appliedNames.has(f));
    console.log(`\n  Total: ${files.length}  |  Applied: ${applied.length}  |  Pending: ${pending.length}\n`);
  } finally {
    client.release();
    await pool.end();
  }
}

async function up(targetName) {
  const pool = getPool();
  const client = await pool.connect();
  let lockHeld = false;
  try {
    lockHeld = await acquireMigrationLock(client);
    if (!lockHeld) return;

    await ensureTrackingTable(client);
    const applied = await getAppliedMigrations(client);
    const appliedNames = new Set(applied.map(r => r.name));
    const files = getMigrationFiles();
    if (targetName && !files.includes(targetName)) {
      throw new Error(`Migration file not found: ${targetName}`);
    }
    const pending = files.filter(f =>
      !appliedNames.has(f) && (!targetName || f === targetName)
    );

    if (pending.length === 0) {
      console.log(targetName
        ? `  Nothing to migrate — ${targetName} is already applied.`
        : '  Nothing to migrate — all migrations are applied.');
      return;
    }

    const maxBatchRow = await client.query(`SELECT COALESCE(MAX(batch), 0) AS max_batch FROM ${TRACKING_TABLE}`);
    const nextBatch = maxBatchRow.rows[0].max_batch + 1;

    for (const file of pending) {
      const modulePath = path.join(MIGRATIONS_DIR, file);
      const mod = await import(pathToFileURL(modulePath).href);
      console.log(`  ↑ Running ${file} ...`);
      // A migration that exports `transaction = false` runs outside BEGIN/COMMIT,
      // for statements PostgreSQL refuses inside a transaction (CREATE INDEX
      // CONCURRENTLY). It must be safe to run again, because a failure part-way
      // leaves its earlier statements applied and the migration unrecorded.
      if (mod.transaction === false) {
        try {
          await mod.up(client);
          await client.query(
            `INSERT INTO ${TRACKING_TABLE} (name, batch) VALUES ($1, $2)`,
            [file, nextBatch],
          );
          console.log(`  ✓ ${file}`);
        } catch (err) {
          console.error(`  ✗ ${file} failed (it ran outside a transaction; fix the cause and run it again):`, err.message);
          throw err;
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await mod.up(client);
        await client.query(
          `INSERT INTO ${TRACKING_TABLE} (name, batch) VALUES ($1, $2)`,
          [file, nextBatch],
        );
        await client.query('COMMIT');
        console.log(`  ✓ ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`  ✗ ${file} failed:`, err.message);
        throw err;
      }
    }
    console.log(`\n  Batch ${nextBatch}: ${pending.length} migration(s) applied.\n`);
  } finally {
    if (lockHeld) {
      try { await client.query('SELECT pg_advisory_unlock(8623)'); } catch (_e) { /* connection release also drops the lock */ }
    }
    client.release();
    await pool.end();
  }
}

async function down() {
  const pool = getPool();
  const client = await pool.connect();
  let lockHeld = false;
  try {
    lockHeld = await acquireMigrationLock(client);
    if (!lockHeld) return;
    await ensureTrackingTable(client);
    const maxBatchRow = await client.query(`SELECT COALESCE(MAX(batch), 0) AS max_batch FROM ${TRACKING_TABLE}`);
    const maxBatch = maxBatchRow.rows[0].max_batch;
    if (maxBatch === 0) {
      console.log('  Nothing to rollback.');
      return;
    }

    const { rows: batchRows } = await client.query(
      `SELECT name FROM ${TRACKING_TABLE} WHERE batch = $1 ORDER BY id DESC`,
      [maxBatch],
    );

    // Resolve and preflight the complete batch before opening any transaction.
    const migrations = [];
    for (const { name } of batchRows) {
      const mod = await import(pathToFileURL(path.join(MIGRATIONS_DIR, name)).href);
      if (mod.irreversible === true || typeof mod.down !== 'function') {
        throw new Error(`Batch ${maxBatch} contains irreversible migration ${name}; no migrations were rolled back.`);
      }
      migrations.push({ name, mod });
    }
    // A later down failure must also roll back earlier down work and history.
    await client.query('BEGIN');
    try {
      for (const { name, mod } of migrations) {
        console.log(`  ↓ Rolling back ${name} ...`);
        await mod.down(client);
        await client.query(`DELETE FROM ${TRACKING_TABLE} WHERE name = $1`, [name]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('  ✗ Rollback batch failed; no migrations were rolled back.');
      throw error;
    }
    console.log(`\n  Batch ${maxBatch}: ${batchRows.length} migration(s) rolled back.\n`);
  } finally {
    if (lockHeld) {
      try { await client.query('SELECT pg_advisory_unlock(8623)'); } catch (_e) { /* connection release drops the lock */ }
    }
    client.release();
    await pool.end();
  }
}

async function markApplied(name) {
  if (!name) { console.error('  Please provide a migration file name.'); process.exit(1); }
  const pool = getPool();
  const client = await pool.connect();
  let lockHeld = false;
  try {
    lockHeld = await acquireMigrationLock(client);
    if (!lockHeld) return;
    await ensureTrackingTable(client);
    const maxBatchRow = await client.query(`SELECT COALESCE(MAX(batch), 0) AS max_batch FROM ${TRACKING_TABLE}`);
    const nextBatch = maxBatchRow.rows[0].max_batch + 1;
    await client.query(
      `INSERT INTO ${TRACKING_TABLE} (name, batch) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
      [name, nextBatch],
    );
    console.log(`  Marked ${name} as applied (batch ${nextBatch}).`);
  } finally {
    if (lockHeld) {
      try { await client.query('SELECT pg_advisory_unlock(8623)'); } catch (_e) { /* connection release drops the lock */ }
    }
    client.release();
    await pool.end();
  }
}

async function create(name) {
  if (!name) { console.error('  Please provide a migration name.'); process.exit(1); }
  const files = getMigrationFiles();
  const highestNumber = files.reduce((highest, file) => {
    const match = /^(\d+)_/.exec(file);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  const nextNum = String(highestNumber + 1).padStart(3, '0');
  const fileName = `${nextNum}_${name.replace(/\s+/g, '_')}.js`;
  const filePath = path.join(MIGRATIONS_DIR, fileName);
  if (fs.existsSync(filePath)) {
    throw new Error(`Migration already exists: ${fileName}`);
  }
  const template = `/**\n * Migration: ${name}\n */\n\nexport async function up(client) {\n  await client.query(\`\n    -- TODO\n  \`);\n}\n\nexport async function down(client) {\n  await client.query(\`\n    -- TODO\n  \`);\n}\n`;
  fs.writeFileSync(filePath, template);
  console.log(`  Created: migrations/${fileName}`);
}

// ── CLI ─────────────────────────────────────────────────────────────────────────

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case 'status':        await status(); break;
  case 'up':            await up(args[0]); break;
  case 'down':          await down(); break;
  case 'mark-applied':  await markApplied(args[0]); break;
  case 'create':        await create(args.join(' ')); break;
  default:
    console.log('Usage: node scripts/migrate.mjs <status|up [name]|down|mark-applied|create> [args]');
    process.exit(1);
}
