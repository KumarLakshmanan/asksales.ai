import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = readFileSync(path.join(root, 'server/scripts/migrate.mjs'), 'utf8');
async function execute(command, { missing = false, fail = false, irreversible = false, locked = false } = {}) {
  const queries = []; let options;
  const context = vm.createContext({ console: { log() {}, error() {} },
    process: { env: { NODE_ENV: 'test', DB_USER: 'fixture', DB_PASSWORD: 'synthetic@host#part', DB_NAME: 'fixture' },
      argv: ['node', 'migrate.mjs', command, '001_fixture.js'], exit(code) { throw new Error(`exit ${code}`); } } });
  const synthetic = (values, identifier) => new vm.SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value);
  }, { context, identifier });
  const client = { release() {}, async query(sql, args) {
    queries.push({ sql: sql.trim(), args });
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ got: !locked }] };
    if (sql.includes('to_regclass')) return { rows: [{ table_name: missing ? null : 'js_migrations' }] };
    if (sql.includes('MAX(batch)')) return { rows: [{ max_batch: 1 }] };
    if (sql.includes('SELECT name FROM')) return { rows: [{ name: '002_fixture.js' }, { name: '001_fixture.js' }] };
    return { rows: [] };
  } };
  const modules = {
    pg: synthetic({ default: { Pool: class { constructor(value) { options = value; }
      async connect() { return client; } async end() {} } } }, 'pg'),
    fs: synthetic({ default: { readdirSync: () => ['001_fixture.js', '002_fixture.js'] } }, 'fs'),
    path: synthetic({ default: path }, 'path'), url: synthetic({ fileURLToPath, pathToFileURL }, 'url'),
    dotenv: synthetic({ default: { config() {} } }, 'dotenv'),
  };
  const module = new vm.SourceTextModule(source, { context, identifier: pathToFileURL(path.join(root, 'server/scripts/migrate.mjs')).href,
    initializeImportMeta(meta, module) { meta.url = module.identifier; },
    async importModuleDynamically(name) {
      const first = name.includes('001_fixture');
      const fixture = synthetic({ irreversible: irreversible && first, down: async c => {
        if (fail && first) throw new Error('synthetic failure');
        await c.query('SYNTHETIC_DOWN');
      } }, name);
      await fixture.link(() => {}); await fixture.evaluate(); return fixture;
    } });
  await module.link(name => modules[name]);
  let error; try { await module.evaluate(); } catch (cause) { error = cause; }
  return { queries, options, error, exitCode: context.process.exitCode };
}
test('status on an empty database performs no DDL and preserves reserved password characters', async () => {
  const { queries, options, error } = await execute('status', { missing: true });
  assert.equal(error, undefined); assert.equal(options.password, 'synthetic@host#part');
  assert.equal(options.connectionString, undefined);
  assert(!queries.some(q => /CREATE|INSERT|DELETE|UPDATE/i.test(q.sql)));
  assert.equal(options.connectionTimeoutMillis, 10_000);
});
test('irreversible batch refuses before any down SQL or transaction', async () => {
  const { queries, error } = await execute('down', { irreversible: true });
  assert.match(error.message, /irreversible/);
  assert(!queries.some(q => q.sql === 'BEGIN' || q.sql === 'SYNTHETIC_DOWN' || q.sql.startsWith('DELETE')));
});
test('a later down failure rolls back the whole batch without an earlier commit', async () => {
  const { queries, error } = await execute('down', { fail: true });
  assert.match(error.message, /synthetic failure/);
  assert(queries.some(q => q.sql === 'SYNTHETIC_DOWN'));
  assert.equal(queries.filter(q => q.sql === 'COMMIT').length, 0);
  assert.equal(queries.filter(q => q.sql === 'ROLLBACK').length, 1);
});
test('all refusal-only down implementations declare irreversible metadata', () => {
  for (const file of readdirSync(path.join(root, 'server/migrations'))) {
    if (!file.endsWith('.js')) continue;
    const text = readFileSync(path.join(root, 'server/migrations', file), 'utf8');
    if (/export async function down\([^)]*\)\s*\{\s*throw new Error/.test(text)) {
      assert.match(text, /export const irreversible = true/, file);
    }
  }
});

test('rollback keeps the Data session lock over the complete Release transaction and failure cleanup', async () => {
  for (const fail of [false, true]) {
    const { queries, error } = await execute('down', { fail });
    assert.equal(Boolean(error), fail);
    const sql = queries.map(q => q.sql);
    assert(sql[0].includes('pg_try_advisory_lock(8623)'));
    assert(sql.indexOf('BEGIN') < sql.indexOf('SYNTHETIC_DOWN'));
    const finish = sql.indexOf(fail ? 'ROLLBACK' : 'COMMIT');
    assert(finish > sql.lastIndexOf('SYNTHETIC_DOWN'));
    assert(sql.indexOf('SELECT pg_advisory_unlock(8623)') > finish);
  }
});

test('mark-applied shares the migration lock and lock contention performs no ledger writes', async () => {
  const accepted = await execute('mark-applied');
  assert.equal(accepted.error, undefined);
  const sql = accepted.queries.map(q => q.sql);
  assert(sql[0].includes('pg_try_advisory_lock(8623)'));
  assert(sql.findIndex(s => s.startsWith('INSERT')) > 0);
  assert.equal(sql.at(-1), 'SELECT pg_advisory_unlock(8623)');
  for (const command of ['up', 'down', 'mark-applied']) {
    const blocked = await execute(command, { locked: true });
    assert.equal(blocked.error, undefined);
    assert.equal(blocked.exitCode, 2);
    assert.equal(blocked.queries.length, 1);
  }
});
