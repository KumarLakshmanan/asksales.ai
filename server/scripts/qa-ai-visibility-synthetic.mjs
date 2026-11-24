/** Apply actual migrations to a new disposable synthetic fixture, without dotenv. */
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const connectionString = process.env.AI_VISIBILITY_SYNTHETIC_DATABASE_URL;
if (!connectionString) throw new Error('AI_VISIBILITY_SYNTHETIC_DATABASE_URL is required');
const url = new URL(connectionString);
if (url.hostname !== '127.0.0.1' || url.port !== '55440' || !url.pathname.startsWith('/synthetic_ai_visibility_qa_')) throw new Error('Refusing a non-fixture database');
const pool = new pg.Pool({ connectionString });
const client = await pool.connect();
try {
  const name = (await client.query('SELECT current_database() AS name')).rows[0].name;
  if (`/${name}` !== url.pathname) throw new Error('Unexpected fixture database');
  await client.query('SELECT pg_advisory_lock(8623)');
  await client.query('CREATE TABLE IF NOT EXISTS js_migrations (id serial PRIMARY KEY,name varchar(255) NOT NULL UNIQUE,batch integer NOT NULL DEFAULT 1,run_on timestamptz NOT NULL DEFAULT now())');
  const applied = new Set((await client.query('SELECT name FROM js_migrations')).rows.map(row => row.name));
  const root = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const name of (await fs.readdir(root)).filter(name => name.endsWith('.js')).sort()) {
    if (applied.has(name)) continue;
    await client.query('BEGIN');
    try {
      await (await import(pathToFileURL(`${root}/${name}`).href)).up(client);
      await client.query('INSERT INTO js_migrations(name) VALUES($1)', [name]);
      await client.query('COMMIT');
      console.log('PASS', name);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`Synthetic migration ${name} failed`, { cause: error });
    }
  }
  console.log('Synthetic fixture migrations current. No customer data was loaded.');
} finally {
  await client.query('SELECT pg_advisory_unlock(8623)');
  client.release();
  await pool.end();
}
