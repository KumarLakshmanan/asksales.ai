/**
 * LLM / AI Constants
 *
 * Model names, pricing, default temperatures, and token limits.
 * Import from here instead of hardcoding model strings or costs.
 */

// ─── Default Model Names ────────────────────────────────────────────────────────

/** Default OpenAI model used when admin configures OpenAI */
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

/** Pinned OpenRouter fallback used when an admin has not selected a model. */
export const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-sonnet-4.6';

/** Default Gemini model used when admin configures Gemini Generative Language */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';

/** Conservative default for Google Cloud Vertex AI text generation. */
export const DEFAULT_VERTEX_MODEL = 'gemini-2.5-flash';

/** Image generation model (Gemini native image — responseModalities: ['IMAGE']) */
export const GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image';

/** Video generation model (Veo 3.1 via Vertex AI) */
export const GEMINI_VIDEO_MODEL = 'veo-3.1-fast-generate-001';

/** Known valid image generation models (used to validate admin credential config) */
export const VALID_IMAGE_MODELS = [
  'gemini-2.5-flash-image',
];

/** Known valid video generation models */
export const VALID_VIDEO_MODELS = [
  'veo-3.1-generate-001',
  'veo-3.1-fast-generate-001',
];

// ─── Fallback Model Lists (for 503 / model-level retry) ─────────────────────────

/**
 * When the configured model returns 503 (temporary overload),
 * try these alternative models within the same provider before switching providers entirely.
 * Listed in preference order — most capable first.
 */
export const GEMINI_FALLBACK_MODELS: string[] = [
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-2.5-flash',
];

export const OPENAI_FALLBACK_MODELS: string[] = [
  'gpt-4o-mini',
  'gpt-4o',
  'gpt-4.1-mini',
  'gpt-3.5-turbo',
];

export const OPENROUTER_FALLBACK_MODELS: string[] = [
  'google/gemini-3.1-flash-lite',
  'openai/gpt-4o-mini',
];

/** Map of provider → fallback model list */
export const PROVIDER_FALLBACK_MODELS: Record<string, string[]> = {
  gemini: GEMINI_FALLBACK_MODELS,
  vertex_ai: GEMINI_FALLBACK_MODELS,
  openai: OPENAI_FALLBACK_MODELS,
  openrouter: OPENROUTER_FALLBACK_MODELS,
};

const RETIRED_MODEL_REPLACEMENTS: Record<string, Record<string, string>> = {
  gemini: {
    'gemini-3.1-flash-lite-preview': 'gemini-3.1-flash-lite',
    'gemini-2.0-flash': 'gemini-3.1-flash-lite',
    'gemini-2.0-flash-lite': 'gemini-3.1-flash-lite',
  },
  vertex_ai: {
    'gemini-3.1-flash-lite-preview': 'gemini-3.1-flash-lite',
  },
  openrouter: {
    'google/gemini-3.1-flash-lite-preview': 'google/gemini-3.1-flash-lite',
  },
};

/**
 * Resolve retired model IDs at runtime so existing credential records continue
 * working without a database mutation. Unknown/custom model IDs pass through.
 */
export function normalizeLLMModelName(provider: string, modelName?: string): string {
  const normalizedProvider = provider === 'google' ? 'gemini' : provider.toLowerCase().trim();
  const normalizedModel = modelName?.trim() || '';
  return RETIRED_MODEL_REPLACEMENTS[normalizedProvider]?.[normalizedModel] || normalizedModel;
}

// ─── Default Temperatures ───────────────────────────────────────────────────────

/** Default temperature for most LLM calls */
export const DEFAULT_LLM_TEMPERATURE = 0.7;

/** Low temperature for classification / intent detection */
export const CLASSIFICATION_TEMPERATURE = 0.1;

/** Medium-low temperature for structured generation (ICP, channel decisions) */
export const STRUCTURED_GENERATION_TEMPERATURE = 0.3;

// ─── Temperature-Restricted Models ─────────────────────────────────────────────

/**
 * OpenAI reasoning model name prefixes that only support temperature=1 (the default).
 * Sending any other value causes a 400 Bad Request error.
 * Includes o-series reasoning models AND the gpt-5 generation which has the same restriction.
 */
const TEMPERATURE_RESTRICTED_PREFIXES = ['o1', 'o3', 'o4', 'gpt-5'];

/**
 * Returns true if the model supports custom temperature values.
 * OpenAI's reasoning models (o1, o3, o4-mini, etc.) only support temperature=1.
 * Also handles OpenRouter format: "openai/o1" → strips provider prefix first.
 */
export function supportsCustomTemperature(modelName: string): boolean {
  if (!modelName) return true;
  const lower = modelName.toLowerCase().trim();
  // Strip provider prefix (e.g. "openai/o3-mini" → "o3-mini")
  const baseName = lower.includes('/') ? lower.split('/').pop()! : lower;
  return !TEMPERATURE_RESTRICTED_PREFIXES.some(
    (prefix) => baseName === prefix || baseName.startsWith(`${prefix}-`)
  );
}

/**
 * Returns true if the model requires `max_completion_tokens` instead of `max_tokens`.
 * OpenAI's reasoning/gpt-5 models deprecated max_tokens in favour of max_completion_tokens.
 */
export function needsMaxCompletionTokens(modelName: string): boolean {
  return !supportsCustomTemperature(modelName);
}

// ─── Default Max Tokens ─────────────────────────────────────────────────────────

/** Max tokens for ICP classification response */
export const ICP_CLASSIFICATION_MAX_TOKENS = 200;

/** Max tokens for ICP generation response */
export const ICP_GENERATION_MAX_TOKENS = 2500;

/** Max tokens for email smart reply / generation */
export const EMAIL_GENERATION_MAX_TOKENS = 500;

