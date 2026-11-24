/**
 * Migration: add_original_cost_to_api_pricing
 * Adds original API provider cost columns alongside user-facing price
 * to support revenue tracking (our price - original cost = revenue).
 */

export async function up(client) {
  // Add original cost columns to api_pricing
  await client.query(`
    ALTER TABLE api_pricing 
    ADD COLUMN IF NOT EXISTS original_prompt_cost_per_million DECIMAL(12, 6) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS original_completion_cost_per_million DECIMAL(12, 6) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS original_credits_per_unit DECIMAL(10, 2) DEFAULT 0
  `);

  // Seed original costs = same as user-facing prices initially (0% margin by default)
  await client.query(`
    UPDATE api_pricing 
    SET original_prompt_cost_per_million = prompt_cost_per_million,
        original_completion_cost_per_million = completion_cost_per_million,
        original_credits_per_unit = credits_per_unit
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE api_pricing 
    DROP COLUMN IF EXISTS original_prompt_cost_per_million,
    DROP COLUMN IF EXISTS original_completion_cost_per_million,
    DROP COLUMN IF EXISTS original_credits_per_unit
  `);
}
