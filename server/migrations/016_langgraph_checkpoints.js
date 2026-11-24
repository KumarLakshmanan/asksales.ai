/**
 * Migration: langgraph_checkpoints
 * Source: migrations/langgraph_checkpoints.sql
 * Generated: 2026-03-06T08:18:41.182Z
 */

export async function up(client) {
    await client.query(`CREATE TABLE IF NOT EXISTS checkpoints (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL,
    parent_checkpoint_id TEXT,
    type TEXT,
    checkpoint JSONB NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS checkpoint_migrations (
    v INTEGER NOT NULL PRIMARY KEY
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS checkpoint_blobs (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL,
    version TEXT NOT NULL,
    type TEXT NOT NULL,
    blob BYTEA,
    PRIMARY KEY (thread_id, checkpoint_ns, channel, version)
)`);

    await client.query(`CREATE TABLE IF NOT EXISTS checkpoint_writes (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    channel TEXT NOT NULL,
    type TEXT,
    blob BYTEA NOT NULL,
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
)`);

    // Grant privileges only if the role exists (production only)
    await client.query(`DO $$ BEGIN
      EXECUTE 'GRANT ALL PRIVILEGES ON checkpoints TO salesmarketing';
      EXECUTE 'GRANT ALL PRIVILEGES ON checkpoint_migrations TO salesmarketing';
      EXECUTE 'GRANT ALL PRIVILEGES ON checkpoint_blobs TO salesmarketing';
      EXECUTE 'GRANT ALL PRIVILEGES ON checkpoint_writes TO salesmarketing';
    EXCEPTION WHEN undefined_object THEN
      RAISE NOTICE 'Skipping GRANT — role salesmarketing does not exist in this environment';
    END $$`);}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS checkpoint_writes`);
  await client.query(`DROP TABLE IF EXISTS checkpoint_blobs`);
  await client.query(`DROP TABLE IF EXISTS checkpoint_migrations`);
  await client.query(`DROP TABLE IF EXISTS checkpoints`);
}
