import type { Response } from 'express';
import { platformAIQuotaMessage } from '../../../shared/assistantModelCatalog.js';
import { classifyLLMProviderFailure, isProviderResponseError } from '../agents/LLMProviderErrors.js';

/** What the user asked for, written as it appears in a sentence ("an email", "a blog post"). */
export type ContentTextKind = 'an email' | 'an email template' | 'an email sequence' | 'an SMS' | 'a social post' | 'a social message' | 'ad copy' | 'a blog post'
  | 'a reply' | 'a proposal' | 'a campaign plan' | 'a campaign' | 'an ICP' | 'this content';

const capitalized = (kind: ContentTextKind) => kind === 'ad copy' ? 'Ad copy' : kind === 'this content' ? 'Content' : `${kind.replace(/^an? /, '').replace(/^\w/, letter => letter.toUpperCase())}`;

/** Errors LLMProviderFactory throws before any provider is called (no key, every key exhausted). */
const PROVIDER_SETUP_FAILURE = /no active LLM (?:API keys|credentials)|no LLM provider configured|all LLM API keys have hit rate limits/i;

/** Keep provider bodies, request data and credentials out of HTTP recovery errors. */
export class ContentTextGenerationError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(upstream: string | undefined, kind: ContentTextKind = 'an email') {
    const category = classifyLLMProviderFailure(upstream).category;
    const noun = kind.replace(/^an? /, '');
    const failure = /no active LLM (?:API keys|credentials)|no LLM provider configured|not configured|missing API key/i.test(upstream || '')
      ? { status: 503, code: 'AI_PROVIDER_NOT_CONFIGURED', message: `${capitalized(kind)} generation is unavailable because no AI provider is configured. Ask an administrator to check AI provider configuration.` }
      : {
        output_budget: { status: 503, code: 'AI_PROVIDER_OUTPUT_LIMIT', message: 'The AI provider could not complete this request within its output budget. Ask an administrator to check the configured output limit.' },
        insufficient_credits: { status: 503, code: 'AI_PROVIDER_CREDITS', message: platformAIQuotaMessage() },
        rate_limited: { status: 503, code: 'AI_PROVIDER_UNAVAILABLE', message: 'The AI provider is temporarily unavailable or rate limited. Please try again later.' },
        timeout: { status: 504, code: 'AI_PROVIDER_TIMEOUT', message: `The AI provider timed out before returning ${kind}. Please try again.` },
        empty_response: { status: 502, code: 'AI_PROVIDER_INVALID_RESPONSE', message: `The AI provider returned an invalid ${noun}. Please generate it again.` },
        unavailable: { status: 502, code: 'AI_PROVIDER_FAILED', message: `The AI provider could not generate ${kind}. Please try again later or ask an administrator to check the provider configuration.` },
      }[category];
    super(failure.message);
    this.name = 'ContentTextGenerationError';
    this.status = failure.status;
    this.code = failure.code;
  }
}

/**
 * Generators used to fold every provider failure into one generic 500, so a
 * missing key, an empty wallet and a timeout all read "Unable to generate …
 * Please try again." Answer with the classified status and code instead.
 */
export function respondToContentTextGenerationError(
  res: Response,
  error: unknown,
  log: { warn: (details: Record<string, unknown>, message: string) => void },
  service: string,
): boolean {
  if (!(error instanceof ContentTextGenerationError)) return false;
  log.warn({ code: error.code, status: error.status }, `[${service}] AI provider failed`);
  res.status(error.status).json({ success: false, code: error.code, error: error.message });
  return true;
}

/**
 * Turn a provider failure that reached a generator's catch block into the
 * classified error. Only provider responses and provider setup errors qualify,
 * so a database or validation error never reads as "the AI provider failed".
 */
export function providerGenerationFailure(error: unknown, kind: ContentTextKind): ContentTextGenerationError | null {
  if (error instanceof ContentTextGenerationError) return error;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (isProviderResponseError(error) || PROVIDER_SETUP_FAILURE.test(message)) return new ContentTextGenerationError(message, kind);
  return null;
}

/** Answer a generator's failure with the classified provider error, if it is one. */
export function respondToGenerationFailure(
  res: Response,
  error: unknown,
  kind: ContentTextKind,
  log: { warn: (details: Record<string, unknown>, message: string) => void },
  service: string,
): boolean {
  return respondToContentTextGenerationError(res, providerGenerationFailure(error, kind), log, service);
}
