/** Durable handle-enrichment request and fixed-fee reservation receipts. */
export async function up(client) {
  await client.query(`
    ALTER TABLE enrichment_runs
      ADD COLUMN IF NOT EXISTS request_key VARCHAR(128),
      ADD COLUMN IF NOT EXISTS request_fingerprint VARCHAR(64),
      ADD COLUMN IF NOT EXISTS billing_transaction_id INTEGER,
      ADD COLUMN IF NOT EXISTS billing_credits NUMERIC(10,2),
      ADD COLUMN IF NOT EXISTS billing_status VARCHAR(32),
      ADD COLUMN IF NOT EXISTS provider_dispatch_started_at TIMESTAMP;
    CREATE UNIQUE INDEX IF NOT EXISTS enrichment_runs_request_key_uq
      ON enrichment_runs(business_profile_id,user_id,request_key);
  `);
}

export async function down(client) {
  await client.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM enrichment_runs WHERE request_key IS NOT NULL) THEN
        RAISE EXCEPTION 'Enrichment request receipts must be reviewed before rolling back migration 531';
      END IF;
    END $$;
    DROP INDEX IF EXISTS enrichment_runs_request_key_uq;
    ALTER TABLE enrichment_runs
      DROP COLUMN IF EXISTS request_key,
      DROP COLUMN IF EXISTS request_fingerprint,
      DROP COLUMN IF EXISTS billing_transaction_id,
      DROP COLUMN IF EXISTS billing_credits,
      DROP COLUMN IF EXISTS billing_status,
      DROP COLUMN IF EXISTS provider_dispatch_started_at;
  `);
}
