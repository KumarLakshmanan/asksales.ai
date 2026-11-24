import { redactPiiWithStableTokens } from '../services/agents/orchestration/PrivacyVaultService.js';

const SECRET_KEY_PATTERN = /(?:^|_)(?:access_?token|refresh_?token|token|secret|password|authorization|cookie|api_?key|auth_?key|signature)(?:$|_)/i;
const DIRECT_IDENTIFIER_KEY_PATTERN = /(?:^|_)(?:email|phone|mobile|name|full_?name|first_?name|last_?name|username|handle|address)(?:$|_)/i;

export function redactWebhookText(value: string | null | undefined): string | null {
  if (!value) return value ?? null;
  return redactPiiWithStableTokens(value).redactedText;
}

function sanitizeValue(value: unknown, key = '', seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    if (SECRET_KEY_PATTERN.test(normalizedKey)) return '[REDACTED_SECRET]';
    if (DIRECT_IDENTIFIER_KEY_PATTERN.test(normalizedKey)) return '[REDACTED_PII]';
    return redactWebhookText(value);
  }

  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.map((item) => sanitizeValue(item, key, seen));
    seen.delete(value);
    return result;
  }

  const result: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    result[childKey] = sanitizeValue(childValue, childKey, seen);
  }
  seen.delete(value);
  return result;
}

/**
 * Produces a telemetry-safe copy. Provider routing IDs remain available for
 * diagnostics, while secrets, direct identifiers and PII inside free text do not.
 */
export function sanitizeWebhookPayload(value: unknown): unknown {
  return sanitizeValue(value);
}

export function serializeSanitizedWebhookPayload(value: unknown): string {
  return JSON.stringify(sanitizeWebhookPayload(value));
}

export function sanitizedWebhookPreview(value: unknown, maxLength = 500): string {
  return serializeSanitizedWebhookPayload(value).substring(0, maxLength);
}
