/**
 * Migration: add_ai_provider_to_ai_settings
 * Adds ai_provider column to ai_settings table for provider selection (openai, openrouter, google).
 */

export async function up(client) {
  await client.query(`
    ALTER TABLE ai_settings
    ADD COLUMN IF NOT EXISTS ai_provider VARCHAR(50) DEFAULT 'openai'
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE ai_settings
    DROP COLUMN IF EXISTS ai_provider
  `);
}
