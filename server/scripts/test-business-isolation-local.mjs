/** Own a fresh network-disabled PostgreSQL instance; never read application env files. */
import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { Client } = require('pg');
const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = await mkdtemp('/tmp/salesmarketing-business-isolation-qa-');
const socket = join(directory, 'socket');
const suffix = directory.split('-').at(-1).toLowerCase();
const container = `salesmarketing-business-isolation-qa-${process.pid}-${suffix}`;
const database = `salesmarketing_business_isolation_qa_${process.pid}_${suffix}`;
const dockerEnvironment = { ...process.env };
for (const selector of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) {
  delete dockerEnvironment[selector];
}
const docker = (...args) => execFileSync('docker', ['--host=unix:///var/run/docker.sock', ...args], {
  env: dockerEnvironment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
});
let client;
let containerAttempted = false;
let child;
let cancelled = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { cancelled = true; child?.kill(signal); });
}
try {
  await mkdir(socket);
  // PostgreSQL's container user creates its socket in this exclusively owned mount.
  await chmod(socket, 0o777);
  docker('info', '--format', '{{.ServerVersion}}');
  containerAttempted = true;
  docker('run', '--detach', '--name', container, '--network', 'none',
    '--tmpfs', '/var/lib/postgresql/data:rw',
    '--mount', `type=bind,source=${socket},target=/qa-socket`,
    '-e', `POSTGRES_DB=${database}`, '-e', 'POSTGRES_USER=postgres',
    '-e', 'POSTGRES_PASSWORD=disposable-fixture-only',
    '-e', 'POSTGRES_INITDB_ARGS=--auth-local=trust --auth-host=reject',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=reject',
    'postgres:16', 'postgres', '-c', 'listen_addresses=', '-c', 'unix_socket_directories=/var/run/postgresql,/qa-socket');
  const isolated = JSON.parse(docker('inspect', '--format', '{{json .HostConfig}}', container));
  if (isolated.NetworkMode !== 'none' || Object.keys(isolated.PortBindings || {}).length) {
    throw new Error('QA PostgreSQL must have no network or published ports');
  }
  const deadline = Date.now() + 30000;
  while (true) {
    if (cancelled) throw new Error('QA cancelled');
    if (docker('inspect', '--format', '{{.State.Running}}', container).trim() !== 'true') {
      console.error(docker('logs', container));
      throw new Error('Disposable PostgreSQL exited before becoming ready; inspect its local container logs');
    }
    if (!docker('logs', container).includes('PostgreSQL init process complete; ready for start up.')) {
      if (Date.now() >= deadline) throw new Error('Disposable PostgreSQL initialization timed out');
      await new Promise(resolve => setTimeout(resolve, 200));
      continue;
    }
    client = new Client({ host: socket, port: 5432, user: 'postgres', database,
      password: '', ssl: false, options: '', connectionTimeoutMillis: 1000 });
    try { await client.connect(); break; }
    catch (error) {
      await client.end().catch(() => {});
      if (Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  await client.query('BEGIN');
  await client.query(await readFile(new URL('../tests/fixtures/businessIsolationPre299.sql', import.meta.url), 'utf8'));
  // Install the real earlier trigger, including its original SECURITY DEFINER,
  // so migration 299 must convert it before the acceptance checks can pass.
  const migration220 = await readFile(new URL('../migrations/220_harden_support_notification_delivery.js', import.meta.url), 'utf8');
  const supportFunction = migration220.match(/CREATE OR REPLACE FUNCTION resolve_support_ticket_team\(\)[\s\S]*?END; \$\$/)?.[0];
  if (!supportFunction) throw new Error('Canonical support-team trigger source is unavailable');
  await client.query(supportFunction);
  await client.query(`CREATE TRIGGER support_ticket_team_resolution_trg BEFORE INSERT ON support_tickets
    FOR EACH ROW EXECUTE FUNCTION resolve_support_ticket_team()`);
  // The migration reads these selectors only to grant its runtime role. Keep
  // them synthetic even if the invoking shell has application DB variables.
  process.env.DB_USER = 'postgres';
  process.env.DB_RUNTIME_USER = 'postgres';
  const { up } = await import('../migrations/299_business_profile_isolation.js');
  await up(client);
  await client.query('COMMIT');
  const coverage = await client.query(`SELECT count(*)::int AS classified_business_tables,
    count(*) FILTER(WHERE c.relrowsecurity AND c.relforcerowsecurity)::int AS forced_rls_tables
    FROM business_scope_tables m JOIN pg_class c ON c.oid=('public.'||m.table_name)::regclass`);
  console.log('Synthetic schema with unchanged migration 299:', coverage.rows[0]);
  console.log('PostgreSQL:', (await client.query('SHOW server_version')).rows[0].server_version);
  console.log('Container image:', docker('inspect', '--format', '{{.Image}}', container).trim());
  console.log('Isolation: network=none; TCP disabled; no published ports; synthetic data only.');
  await client.end(); client = undefined;
  if (cancelled) throw new Error('QA cancelled');
  const args = ['--experimental-vm-modules', require.resolve('jest/bin/jest'),
    '--runInBand', '--runTestsByPath',
    'tests/businessProfileIsolationPostgres.test.ts',
    'tests/leadExportScopePostgres.test.ts',
    'tests/businessScopeBoundaries.test.ts',
    'tests/tenantAuthorizationLifecycle.test.ts'];
  if (process.env.BUSINESS_ISOLATION_QA_RESULTS_FILE) {
    args.push('--json', '--outputFile', process.env.BUSINESS_ISOLATION_QA_RESULTS_FILE);
  }
  const code = await new Promise((resolve, reject) => {
    child = spawn(process.execPath, args, { cwd: serverRoot, stdio: 'inherit', env: {
      ...process.env, NODE_ENV: 'test',
      BUSINESS_ISOLATION_TEST_DATABASE: database, BUSINESS_ISOLATION_TEST_SOCKET: socket,
      LEAD_EXPORT_LOCAL_QA: '1', DB_HOST: socket, DB_PORT: '5432', DB_NAME: database,
      DB_USER: 'postgres', DB_PASSWORD: '', DB_SSL: 'false',
    } });
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
  });
  if (code || cancelled) process.exitCode = code || 1;
} catch (error) {
  // Avoid echoing environment values or generated connection strings.
  console.error('Disposable business-isolation QA failed:', error.code || error.name, error.message);
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => {});
  let cleanupSucceeded = true;
  if (containerAttempted) {
    try {
      // Inspect after a failed/timed-out create rather than repeat that mutation.
      const found = docker('ps', '--all', '--filter', `name=^/${container}$`, '--format', '{{.Names}}').trim();
      if (found === container) {
        docker('rm', '--force', container);
        console.log('Removed disposable PostgreSQL container.');
      }
    } catch {
      console.error(`Cleanup required for local container ${container} and socket directory ${directory}`);
      cleanupSucceeded = false;
      process.exitCode = 1;
    }
  }
  if (cleanupSucceeded) await rm(directory, { recursive: true, force: true });
}
