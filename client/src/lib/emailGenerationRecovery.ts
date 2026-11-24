import { ApiError } from './api-client';
import { readEmailDraft, type EmailDraft } from './emailTemplateSections';
import { platformAIQuotaMessage } from '../../../shared/assistantModelCatalog';

export const EMAIL_GENERATION_WAIT_MS = 3 * 60 * 1000;
export const EMAIL_SAVE_UNCONFIRMED = 'Generation returned without a confirmed saved draft. Check email templates before generating again.';
export const EMAIL_WAIT_CANCELLED = 'Stopped waiting for email generation. The request may still finish; check email templates before generating again.';
export const EMAIL_WAIT_TIMED_OUT = 'Email generation is taking longer than expected. The request may still finish; check email templates before generating again.';

/** Errors created by our own receipt/output checks are already safe to show. */
export class EmailGenerationRecoveryError extends Error {}

/** Both persisted Studio responses and persist:false campaign responses must contain real copy. */
export function parseGeneratedEmailResponse(response: unknown): EmailDraft {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new EmailGenerationRecoveryError('The AI provider returned an invalid email. Your draft has been kept.');
  }
  const envelope = response as Record<string, unknown>;
  if (envelope.success !== true) throw new ApiError('Email generation failed', 502, envelope);
  let content: unknown = envelope.emailContent ?? envelope.content ?? envelope;
  if (typeof content === 'string') {
    try { content = JSON.parse(content); }
    catch { throw new EmailGenerationRecoveryError('The AI provider returned an invalid email. Your draft has been kept.'); }
  }
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new EmailGenerationRecoveryError('The AI provider returned an invalid email. Your draft has been kept.');
  }
  const fields = content as Record<string, unknown>;
  if (typeof fields.subject !== 'string' || !fields.subject.trim() || fields.subject.length > 200
    || typeof fields.body !== 'string' || !fields.body.trim() || fields.body.length > 50_000) {
    throw new EmailGenerationRecoveryError('The AI provider returned an invalid email. Your draft has been kept.');
  }
  return readEmailDraft(content);
}

export function emailGenerationErrorMessage(error: unknown, destination: 'library' | 'compose' = 'library'): string {
  if (error instanceof EmailGenerationRecoveryError) return error.message;
  if (error instanceof ApiError) {
    const data = error.data && typeof error.data === 'object' ? error.data as { code?: unknown } : {};
    const messages: Record<string, string> = {
      AI_PROVIDER_NOT_CONFIGURED: 'Email generation is unavailable because no AI provider is configured. Ask an administrator to check AI provider configuration.',
      AI_PROVIDER_CREDITS: platformAIQuotaMessage(),
      AI_PROVIDER_OUTPUT_LIMIT: 'The AI provider could not complete this request within its output budget. Ask an administrator to check the configured output limit.',
      AI_PROVIDER_UNAVAILABLE: 'The AI provider is temporarily unavailable or rate limited. Please try again later.',
      AI_PROVIDER_TIMEOUT: destination === 'compose' ? 'The AI provider timed out before returning an email. Your draft has been kept.' : 'The AI provider timed out before returning an email. Check email templates before trying again.',
      AI_PROVIDER_INVALID_RESPONSE: 'The AI provider returned an invalid email. Please generate it again.',
      AI_PROVIDER_FAILED: 'The AI provider could not generate the email. Please try again later or ask an administrator to check the provider configuration.',
      EMAIL_SAVE_UNCONFIRMED: destination === 'compose' ? 'The generated email could not be confirmed. Your draft has been kept.' : EMAIL_SAVE_UNCONFIRMED,
      CONTENT_REQUEST_PENDING: destination === 'compose' ? 'This generation is still running or its result is unconfirmed. Your draft has been kept.' : 'This generation is still running or its result is unconfirmed. Check email templates before generating again.',
      CONTENT_REQUEST_EXPIRED: destination === 'compose' ? 'This generation receipt has expired. Your draft has been kept.' : 'This generation receipt has expired. Check email templates for the saved result.',
      REQUEST_KEY_CONFLICT: destination === 'compose' ? 'The generation recovery key conflicts with this request. Your draft has been kept.' : 'The generation recovery key conflicts with this request. Check email templates before generating again.',
      // The server failed before any draft existed, so nothing was saved and retrying is safe.
      EMAIL_GENERATION_FAILED: destination === 'compose' ? 'Email generation failed and no email was created. Your draft and settings are kept. Try again.' : 'Email generation failed and nothing was saved. Your prompt and settings are kept. Try again.',
    };
    messages.CONTENT_GENERATION_FAILED = messages.EMAIL_GENERATION_FAILED;
    if (typeof data.code === 'string' && Object.hasOwn(messages, data.code)) return messages[data.code];
    if (error.status === 503) return 'Email generation is temporarily unavailable. Your prompt and settings are kept. Try again in a few seconds.';
    if (error.status === 400) return 'Review the email prompt and generation settings. The complete prompt must be at most 20,000 characters.';
    if (error.status === 401) return 'Sign in again before generating an email. Your draft has been kept.';
    if (error.status === 402) return 'Your account has insufficient credits for email generation. Check your wallet balance.';
    if (error.status === 403) return 'Email generation is not permitted for the selected business. Check your workspace access and selected business.';
    if (error.status === 404 || error.status === 409) return 'Review the selected business, Brand Toolkit, audience, thread and template before generating again.';
    if (error.status === 422) return 'The generated email did not pass brand and channel validation. Review your request before trying again.';
    if (error.status === 429) return 'Email generation is rate limited. Please try again later.';
  }
  return destination === 'compose' ? 'Email generation could not be confirmed. Your draft has been kept. Please try again later.' : 'Email generation could not be confirmed. Check email templates before generating again.';
}
