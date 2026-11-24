/**
 * Migration 092 — outreachJobs.is_dead_letter
 * Phase 5.15 / MODEL-010: dead-letter marker. The worker flips this to
 * true when a job has exhausted all attempts so the UI can surface a
 * "needs manual review" list.
 */
export const up = async (db) => {
  await db.query(`ALTER TABLE outreach_jobs ADD COLUMN IF NOT EXISTS is_dead_letter BOOLEAN NOT NULL DEFAULT false;`);
  await db.query(`CREATE INDEX IF NOT EXISTS outreach_jobs_is_dead_letter_idx ON outreach_jobs (is_dead_letter) WHERE is_dead_letter = true;`);
};

export const down = async (db) => {
  await db.query(`DROP INDEX IF EXISTS outreach_jobs_is_dead_letter_idx;`);
  await db.query(`ALTER TABLE outreach_jobs DROP COLUMN IF EXISTS is_dead_letter;`);
};
