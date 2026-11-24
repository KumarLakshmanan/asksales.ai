import { platformAIQuotaMessage } from '../../../shared/assistantModelCatalog.js';

/**
 * Marks a failed response returned by an LLM adapter. Provider adapters return
 * `{ success: false }` rather than throwing, so callers need an explicit error
 * type to distinguish an upstream failure from an application exception.
 */
export class LLMProviderResponseError extends Error {
  readonly isProviderResponseError = true;

  constructor(
    message: string,
    readonly provider: string,
    readonly model: string,
  ) {
    super(message);
    this.name = 'LLMProviderResponseError';
  }
}

export class LLMProviderQuotaError extends LLMProviderResponseError {
  constructor(providers: string[]) {
    super(platformAIQuotaMessage(providers), 'AI provider', '');
    this.name = 'LLMProviderQuotaError';
  }
}

export function isProviderResponseError(error: unknown): error is LLMProviderResponseError {
  return error instanceof LLMProviderResponseError
    || Boolean(error && typeof error === 'object' && 'isProviderResponseError' in error);
}

export type LLMProviderFailureCategory =
  | 'output_budget'
  | 'insufficient_credits'
  | 'rate_limited'
  | 'empty_response'
  | 'timeout'
  | 'unavailable';

export interface LLMProviderFailureClassification {
  category: LLMProviderFailureCategory;
  status?: number;
  affordableOutputTokens?: number;
}

function errorObject(error: unknown): Record<string, unknown> | null {
  return error && typeof error === 'object' ? error as Record<string, unknown> : null;
}

function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  const root = errorObject(error);
  const nested = errorObject(root?.error);
  const response = errorObject(root?.response);
  const responseData = errorObject(response?.data);
  const responseError = errorObject(responseData?.error);
  for (const value of [root?.message, nested?.message, responseError?.message]) {
    if (typeof value === 'string') return value;
  }
  return '';
}

function safeStatus(value: unknown): number | undefined {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d{3}$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(numeric) && numeric >= 400 && numeric <= 599 ? numeric : undefined;
}

function errorStatus(error: unknown): number | undefined {
  const root = errorObject(error);
  const nested = errorObject(root?.error);
  const response = errorObject(root?.response);
  const fromFields = safeStatus(root?.status) ?? safeStatus(root?.statusCode)
    ?? safeStatus(nested?.status) ?? safeStatus(response?.status);
  if (fromFields) return fromFields;
  return errorText(error).match(/\bHTTP\s+([45]\d\d)\b/i)?.[1]
    ? Number(errorText(error).match(/\bHTTP\s+([45]\d\d)\b/i)![1])
    : undefined;
}

function affordableTokenCount(message: string): number | undefined {
  const match = message.match(/can only afford\s+([\d,]+)(?:\s+tokens?)?/i);
  if (!match) return undefined;
  const count = Number(match[1].replaceAll(',', ''));
  return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

/**
 * Parse only OpenRouter's explicit request-specific affordability response.
 * Requiring the reported request size to match the bounded request prevents
 * retrying based on unrelated or ambiguous provider prose.
 */
export function parseOpenRouterAffordableOutputCap(
  error: unknown,
  requestedMaxTokens: number,
): number | null {
  const message = errorText(error);
  const status = errorStatus(error);
  const requestedMatch = message.match(/requested up to\s+([\d,]+)\s+tokens?/i);
  const affordable = affordableTokenCount(message);
  if (status !== 402 || !/fewer\s+max_tokens/i.test(message) || !requestedMatch || affordable === undefined) {
    return null;
  }

  const reportedRequest = Number(requestedMatch[1].replaceAll(',', ''));
  if (!Number.isSafeInteger(requestedMaxTokens) || requestedMaxTokens < 256
    || reportedRequest !== requestedMaxTokens || affordable < 256 || affordable >= requestedMaxTokens) {
    return null;
  }

  // Leave 10% headroom for provider-side accounting variance. This is one
  // bounded retry only; a second rejection is surfaced without another call.
  const conservativeCap = Math.floor(affordable * 0.9);
  return conservativeCap >= 256 && conservativeCap < requestedMaxTokens ? conservativeCap : null;
}

export function classifyLLMProviderFailure(error: unknown): LLMProviderFailureClassification {
  const message = errorText(error);
  const lowerMessage = message.toLowerCase();
  const status = errorStatus(error);
  const affordableOutputTokens = affordableTokenCount(message);

  if (/fewer\s+max_tokens/i.test(message) && affordableOutputTokens !== undefined && affordableOutputTokens > 0) {
    return { category: 'output_budget', status, affordableOutputTokens };
  }
  if (status === 402 || /insufficient(?: provider)? credits|requires more credits|payment required|insufficient balance|quota[_ ]exceeded|exceeded your current quota|insufficient_quota/i.test(message)) {
    return { category: 'insufficient_credits', status };
  }
  if (status === 429 || status === 503 || /rate[ -]?limit|too many requests|temporarily unavailable|service unavailable|overloaded/i.test(lowerMessage)) {
    return { category: 'rate_limited', status };
  }
  if (/timed?\s*out|timeout|deadline exceeded|etimedout|econnaborted/i.test(lowerMessage)) {
    return { category: 'timeout', status };
  }
  if (/no message content|no visible (?:answer|completion)|empty (?:response|completion)/i.test(message)) {
    return { category: 'empty_response', status };
  }
  return { category: 'unavailable', status };
}

/** Return a bounded, actionable message that never echoes the upstream body. */
export function safeLLMProviderFailureMessage(error: unknown, provider = 'AI provider'): string {
  if (error instanceof LLMProviderQuotaError) return error.message;
  const label = ({
    openrouter: 'OpenRouter',
    openai: 'OpenAI',
    gemini: 'Gemini',
    vertex_ai: 'Vertex AI',
    custom_ai: 'configured AI provider',
  } as Record<string, string>)[provider.toLowerCase()] || 'AI provider';
  const failure = classifyLLMProviderFailure(error);
  const status = failure.status ? ` HTTP ${failure.status}` : '';

  switch (failure.category) {
    case 'output_budget':
      return `${label}${status} request requires fewer max_tokens; can only afford ${failure.affordableOutputTokens} tokens. Retry with a lower output limit.`;
    case 'insufficient_credits':
      return `${platformAIQuotaMessage([label])}${status ? ` (${status.trim()})` : ''}`;
    case 'rate_limited':
      return `${label}${status} is temporarily rate-limited or unavailable. Try again later or use another configured provider.`;
    case 'timeout':
      return `${label} request timed out. Try again later or use another configured provider.`;
    case 'empty_response':
      return `${label} returned no visible completion content. Please retry or use another configured provider.`;
    case 'unavailable':
      return `${label}${status} request failed. Check provider status/configuration or use another configured provider.`;
  }
}
