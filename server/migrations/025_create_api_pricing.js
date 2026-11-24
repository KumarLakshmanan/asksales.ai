/**
 * Migration: create_api_pricing
 * Creates api_pricing table for admin-configurable API costs:
 * - LLM model costs (per 1M tokens)
 * - Image/Video generation fixed costs
 * - Apify margin percentage
 * - ZeroBounce per-email cost
 */

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS api_pricing (
      id SERIAL PRIMARY KEY,
      
      -- Category: 'llm_model', 'image_generation', 'video_generation', 'apify', 'zerobounce'
      category VARCHAR(50) NOT NULL,
      
      -- Unique key: for LLM = model name (e.g. 'gpt-4o-mini'), for others = service name
      pricing_key VARCHAR(150) NOT NULL UNIQUE,
      
      -- Display name
      name VARCHAR(255) NOT NULL,
      
      -- Provider: 'openai', 'openrouter', 'gemini', 'apify', 'zerobounce'
      provider VARCHAR(50),
      
      -- For LLM models: cost per 1M prompt tokens (USD)
      prompt_cost_per_million DECIMAL(12, 6) DEFAULT 0,
      
      -- For LLM models: cost per 1M completion tokens (USD)
      completion_cost_per_million DECIMAL(12, 6) DEFAULT 0,
      
      -- For fixed-cost services: credits per unit (image, video, email validation)
      credits_per_unit DECIMAL(10, 2) DEFAULT 0,
      
      -- For Apify: margin percentage to add on top of actual run cost
      margin_percentage DECIMAL(5, 2) DEFAULT 0,
      
      -- Unit label for display (e.g. 'per image', 'per video', 'per email', 'per 1M tokens')
      unit_label VARCHAR(100),
      
      -- Whether this pricing entry is active
      is_active BOOLEAN NOT NULL DEFAULT true,
      
      -- Sort order for display
      sort_order INTEGER DEFAULT 0,
      
      -- Extra config (JSON)
      metadata JSONB,
      
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // Seed default LLM model costs (from llmConstants.ts)
  const llmModels = [
    // OpenAI direct
    { key: 'gpt-5.2', name: 'GPT-5.2', provider: 'openai', prompt: 0.05, completion: 0.15 },
    { key: 'gpt-4o', name: 'GPT-4o', provider: 'openai', prompt: 2.5, completion: 10.0 },
    { key: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai', prompt: 0.15, completion: 0.6 },
    { key: 'gpt-4-turbo', name: 'GPT-4 Turbo', provider: 'openai', prompt: 10.0, completion: 30.0 },
    { key: 'gpt-4', name: 'GPT-4', provider: 'openai', prompt: 30.0, completion: 60.0 },
    { key: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', provider: 'openai', prompt: 0.5, completion: 1.5 },
    // OpenAI via OpenRouter
    { key: 'openai/gpt-5.2', name: 'GPT-5.2 (OpenRouter)', provider: 'openrouter', prompt: 0.05, completion: 0.15 },
    { key: 'openai/gpt-4o', name: 'GPT-4o (OpenRouter)', provider: 'openrouter', prompt: 2.5, completion: 10.0 },
    { key: 'openai/gpt-4o-mini', name: 'GPT-4o Mini (OpenRouter)', provider: 'openrouter', prompt: 0.15, completion: 0.6 },
    { key: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo (OpenRouter)', provider: 'openrouter', prompt: 10.0, completion: 30.0 },
    { key: 'openai/gpt-4', name: 'GPT-4 (OpenRouter)', provider: 'openrouter', prompt: 30.0, completion: 60.0 },
    { key: 'openai/gpt-3.5-turbo', name: 'GPT-3.5 Turbo (OpenRouter)', provider: 'openrouter', prompt: 0.5, completion: 1.5 },
    // Anthropic
    { key: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', provider: 'openrouter', prompt: 3.0, completion: 15.0 },
    { key: 'anthropic/claude-3-opus', name: 'Claude 3 Opus', provider: 'openrouter', prompt: 15.0, completion: 75.0 },
    { key: 'anthropic/claude-3-sonnet', name: 'Claude 3 Sonnet', provider: 'openrouter', prompt: 3.0, completion: 15.0 },
    { key: 'anthropic/claude-3-haiku', name: 'Claude 3 Haiku', provider: 'openrouter', prompt: 0.25, completion: 1.25 },
    // Google via OpenRouter
    { key: 'google/gemini-pro-1.5', name: 'Gemini Pro 1.5 (OpenRouter)', provider: 'openrouter', prompt: 1.25, completion: 5.0 },
    { key: 'google/gemini-flash-1.5', name: 'Gemini Flash 1.5 (OpenRouter)', provider: 'openrouter', prompt: 0.075, completion: 0.3 },
    // Google Gemini direct
    { key: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'gemini', prompt: 0.15, completion: 0.6 },
    { key: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'gemini', prompt: 1.25, completion: 10.0 },
    { key: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'gemini', prompt: 0.1, completion: 0.4 },
    { key: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', provider: 'gemini', prompt: 1.25, completion: 5.0 },
    { key: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', provider: 'gemini', prompt: 0.075, completion: 0.3 },
    // Meta
    { key: 'meta-llama/llama-3.1-70b-instruct', name: 'Llama 3.1 70B', provider: 'openrouter', prompt: 0.52, completion: 0.75 },
    { key: 'meta-llama/llama-3.1-405b-instruct', name: 'Llama 3.1 405B', provider: 'openrouter', prompt: 2.7, completion: 2.7 },
    // Mistral
    { key: 'mistralai/mistral-large', name: 'Mistral Large', provider: 'openrouter', prompt: 2.0, completion: 6.0 },
    { key: 'mistralai/mistral-medium', name: 'Mistral Medium', provider: 'openrouter', prompt: 2.7, completion: 8.1 },
    // xAI
    { key: 'x-ai/grok-4.1-fast:free', name: 'Grok 4.1 Fast (Free)', provider: 'openrouter', prompt: 0, completion: 0 },
    { key: 'x-ai/grok-4.1', name: 'Grok 4.1', provider: 'openrouter', prompt: 3.0, completion: 15.0 },
    { key: 'x-ai/grok-3', name: 'Grok 3', provider: 'openrouter', prompt: 3.0, completion: 15.0 },
    // MiniMax
    { key: 'minimax/minimax-m2.5:free', name: 'MiniMax M2.5 (Free)', provider: 'openrouter', prompt: 0, completion: 0 },
  ];

  let sortOrder = 0;
  for (const m of llmModels) {
    await client.query(`
      INSERT INTO api_pricing (category, pricing_key, name, provider, prompt_cost_per_million, completion_cost_per_million, unit_label, sort_order)
      VALUES ('llm_model', $1, $2, $3, $4, $5, 'per 1M tokens', $6)
      ON CONFLICT (pricing_key) DO NOTHING
    `, [m.key, m.name, m.provider, m.prompt, m.completion, sortOrder++]);
  }

  // Seed image generation pricing (fixed credits per image)
  await client.query(`
    INSERT INTO api_pricing (category, pricing_key, name, provider, credits_per_unit, unit_label, sort_order)
    VALUES ('image_generation', 'image_generation', 'Image Generation', 'gemini', 5, 'per image', 100)
    ON CONFLICT (pricing_key) DO NOTHING
  `);

  // Seed video generation pricing (fixed credits per video)
  await client.query(`
    INSERT INTO api_pricing (category, pricing_key, name, provider, credits_per_unit, unit_label, sort_order)
    VALUES ('video_generation', 'video_generation', 'Video Generation', 'gemini', 20, 'per video', 101)
    ON CONFLICT (pricing_key) DO NOTHING
  `);

  // Seed Apify margin pricing
  await client.query(`
    INSERT INTO api_pricing (category, pricing_key, name, provider, margin_percentage, unit_label, sort_order)
    VALUES ('apify', 'apify_margin', 'Apify Run Margin', 'apify', 20, '% margin on run cost', 200)
    ON CONFLICT (pricing_key) DO NOTHING
  `);

  // Seed ZeroBounce per-email pricing (fixed credits per email validated)
  await client.query(`
    INSERT INTO api_pricing (category, pricing_key, name, provider, credits_per_unit, unit_label, sort_order)
    VALUES ('zerobounce', 'zerobounce_validation', 'Email Validation', 'zerobounce', 1, 'per email', 300)
    ON CONFLICT (pricing_key) DO NOTHING
  `);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS api_pricing`);
}
