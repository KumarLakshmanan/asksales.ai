// AI Visibility asks a fourth AI engine, Claude (through OpenRouter, like the
// other three), so its GEO answers are stored with provider 'claude'.
// The other allowed values are unchanged. Safe to run again.

export async function up(client) {
  await client.query(`
    ALTER TABLE ai_visibility_prompt_runs DROP CONSTRAINT IF EXISTS ai_visibility_prompt_runs_provider_check;
    ALTER TABLE ai_visibility_prompt_runs ADD CONSTRAINT ai_visibility_prompt_runs_provider_check
      CHECK (provider IN ('openai', 'gemini', 'perplexity', 'claude', 'manual'));
  `);
}

export async function down(client) {
  await client.query(`
    DELETE FROM ai_visibility_prompt_runs WHERE provider = 'claude';
    ALTER TABLE ai_visibility_prompt_runs DROP CONSTRAINT IF EXISTS ai_visibility_prompt_runs_provider_check;
    ALTER TABLE ai_visibility_prompt_runs ADD CONSTRAINT ai_visibility_prompt_runs_provider_check
      CHECK (provider IN ('openai', 'gemini', 'perplexity', 'manual'));
  `);
}
