/** Preserve accepted enrichment URLs and labels without truncating provenance. */
export async function up(client) {
  await client.query(`
    ALTER TABLE enrichment_runs ALTER COLUMN lead_name TYPE TEXT;
    ALTER TABLE enrichment_steps ALTER COLUMN identifier TYPE TEXT;
  `);
}

export async function down(client) {
  // A rollback must never silently truncate source identifiers or run labels.
  await client.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM enrichment_runs WHERE length(lead_name) > 255)
        OR EXISTS (SELECT 1 FROM enrichment_steps WHERE length(identifier) > 500) THEN
        RAISE EXCEPTION 'Enrichment source identifiers exceed the legacy limits; retain migration 530 until those records have been reviewed';
      END IF;
    END $$;
    ALTER TABLE enrichment_runs ALTER COLUMN lead_name TYPE VARCHAR(255);
    ALTER TABLE enrichment_steps ALTER COLUMN identifier TYPE VARCHAR(500);
  `);
}
