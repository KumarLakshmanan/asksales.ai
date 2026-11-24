/** Persist the outcome before publishing completion or retrying a queue job. */
export async function up(client) {
  await client.query(`ALTER TABLE enrichment_runs
    ADD COLUMN IF NOT EXISTS execution_result JSONB,
    ADD COLUMN IF NOT EXISTS removal_intents JSONB NOT NULL DEFAULT '{}'::jsonb`);
}

export async function down(client) {
  await client.query(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM enrichment_runs WHERE execution_result IS NOT NULL OR removal_intents <> '{}'::jsonb) THEN
      RAISE EXCEPTION 'Review durable enrichment outcomes before rolling back migration 532';
    END IF;
  END $$;
  ALTER TABLE enrichment_runs DROP COLUMN IF EXISTS execution_result, DROP COLUMN IF EXISTS removal_intents`);
}
