/** Preserve every accepted coalesced request key on its original durable job. */
export async function up(client) {
  await client.query(`ALTER TABLE workspace_website_analysis_jobs
    ADD COLUMN IF NOT EXISTS accepted_request_keys text[] NOT NULL DEFAULT '{}';
    CREATE INDEX IF NOT EXISTS workspace_analysis_request_receipts
      ON workspace_website_analysis_jobs USING gin(accepted_request_keys);`);
}

export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS workspace_analysis_request_receipts;
    ALTER TABLE workspace_website_analysis_jobs DROP COLUMN IF EXISTS accepted_request_keys;`);
}
