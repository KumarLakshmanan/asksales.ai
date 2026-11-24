/**
 * Migration 090 — failed_jobs table
 * Phase 5.5 / QUEUE-009: BullMQ failed-job dump. The `failed` event handler
 * inserts a row with the full payload + error so we can debug dropped
 * jobs after the default 90-day retention (we keep 90d via a nightly prune).
 */
export const up = async (db) => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS failed_jobs (
      id SERIAL PRIMARY KEY,
      queue TEXT NOT NULL,
      job_id TEXT,
      payload JSONB,
      error TEXT,
      stack TEXT,
      failed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS failed_jobs_queue_failed_at_idx ON failed_jobs (queue, failed_at DESC);`);
  await db.query(`CREATE INDEX IF NOT EXISTS failed_jobs_failed_at_idx ON failed_jobs (failed_at);`);
};

export const down = async (db) => {
  await db.query(`DROP TABLE IF EXISTS failed_jobs;`);
};
