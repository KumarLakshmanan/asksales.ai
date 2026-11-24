/**
 * Make storage plan pricing explicit and guarantee one concurrent default.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE storage_plans
      ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'USD';

    UPDATE storage_plans
    SET currency = UPPER(currency)
    WHERE currency <> UPPER(currency);

    UPDATE storage_plans
    SET is_default = false
    WHERE id IN (
      SELECT id
      FROM (
        SELECT id, row_number() OVER (ORDER BY id) AS default_rank
        FROM storage_plans
        WHERE is_default = true
      ) ranked
      WHERE default_rank > 1
    );

    DROP INDEX IF EXISTS storage_plans_single_default;
    CREATE UNIQUE INDEX storage_plans_single_default
      ON storage_plans (is_default)
      WHERE is_default = true;

    ALTER TABLE storage_plans
      DROP CONSTRAINT IF EXISTS storage_plans_currency_format;
    ALTER TABLE storage_plans
      ADD CONSTRAINT storage_plans_currency_format CHECK (currency ~ '^[A-Z]{3}$');
  `);
}

export async function down(client) {
  await client.query(`
    DROP INDEX IF EXISTS storage_plans_single_default;
    ALTER TABLE storage_plans DROP CONSTRAINT IF EXISTS storage_plans_currency_format;
    ALTER TABLE storage_plans DROP COLUMN IF EXISTS currency;
  `);
}
