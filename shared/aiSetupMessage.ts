export const AI_SETUP_UNAVAILABLE = 'The AI service is unavailable. Please ask an administrator to verify the configured AI providers.';

/** Present historical setup errors without directing users to a removed settings flow. */
export function aiSetupErrorDisplay(content: string): string {
  return /(?:LLM|OpenAI|OpenRouter|Gemini|AI providers?)/i.test(content)
    && /(?:not configured|no .{0,30}configured|requires?.{0,20}API key|add.{0,20}API key|configure.{0,30}Settings\s*>)/i.test(content)
    ? AI_SETUP_UNAVAILABLE : content;
}
