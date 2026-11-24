/**
 * Records schema-validated GEO extraction fidelity independently from the raw
 * provider observation. Existing derived rows are retained and labelled as
 * legacy; new observations begin pending structured extraction.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE ai_visibility_prompt_runs
      ADD COLUMN IF NOT EXISTS extraction_status VARCHAR(24) NOT NULL DEFAULT 'legacy',
      ADD COLUMN IF NOT EXISTS extraction_method VARCHAR(48),
      ADD COLUMN IF NOT EXISTS extraction_provider VARCHAR(24),
      ADD COLUMN IF NOT EXISTS extraction_model VARCHAR(100),
      ADD COLUMN IF NOT EXISTS extraction_fidelity VARCHAR(24),
      ADD COLUMN IF NOT EXISTS extraction_error TEXT,
      ADD COLUMN IF NOT EXISTS extraction_input_tokens INTEGER,
      ADD COLUMN IF NOT EXISTS extraction_output_tokens INTEGER,
      ADD COLUMN IF NOT EXISTS extraction_cost_cents NUMERIC(12,4) NOT NULL DEFAULT 0
  `);
  await client.query(`
    ALTER TABLE ai_visibility_prompt_runs
      DROP CONSTRAINT IF EXISTS ai_visibility_prompt_runs_extraction_status_check
  `);
  await client.query(`
    ALTER TABLE ai_visibility_prompt_runs
      ADD CONSTRAINT ai_visibility_prompt_runs_extraction_status_check
      CHECK (extraction_status IN ('pending','completed','failed','corrected','cached','legacy'))
  `);
  await client.query(`
    ALTER TABLE ai_visibility_prompt_runs
      ALTER COLUMN extraction_status SET DEFAULT 'pending'
  `);
  await client.query(`
    INSERT INTO credit_pricing (event_key, name, description, category, credits_per_unit, unit_label, is_active, sort_order, metadata)
    VALUES ('ai_visibility_extraction', 'AI Visibility structured extraction', 'Successful uncached schema-validated provider answer extraction.', 'ai_visibility', 1, 'per successful extraction', TRUE, 703, '{"structuredOutput":true}'::jsonb)
    ON CONFLICT (event_key) DO NOTHING
  `);
}

export async function down(client) {
  await client.query("DELETE FROM credit_pricing WHERE event_key = 'ai_visibility_extraction'");
  await client.query('ALTER TABLE ai_visibility_prompt_runs DROP CONSTRAINT IF EXISTS ai_visibility_prompt_runs_extraction_status_check');
  await client.query(`
    ALTER TABLE ai_visibility_prompt_runs
      DROP COLUMN IF EXISTS extraction_cost_cents,
      DROP COLUMN IF EXISTS extraction_output_tokens,
      DROP COLUMN IF EXISTS extraction_input_tokens,
      DROP COLUMN IF EXISTS extraction_error,
      DROP COLUMN IF EXISTS extraction_fidelity,
      DROP COLUMN IF EXISTS extraction_model,
      DROP COLUMN IF EXISTS extraction_provider,
      DROP COLUMN IF EXISTS extraction_method,
      DROP COLUMN IF EXISTS extraction_status
  `);
}
