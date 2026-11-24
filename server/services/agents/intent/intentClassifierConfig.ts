/** Jev uses Decisions, never /chat/completions. Keep the version explicit. */
export const JEV_MODEL = 'typesafe/jev-1.13';
export const isJevModel = (model: string) => model === JEV_MODEL;
export const INTENT_CONFIDENCE_THRESHOLD = 0.9;
export const INTENT_TIMEOUT_MS = 8_000;
