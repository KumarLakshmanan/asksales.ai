import { redactCredentialText } from './logRedaction.js';

const MAX_DIAGNOSTIC_STRING_LENGTH = 10_000;
const SECRET_KEY_PATTERN = /password|passwd|secret|token|api.?key|authorization|cookie|credential|private.?key|access.?key|refresh.?key|encryption.?key|signature|session/i;
const PII_KEY_PATTERN = /^(email|phone|mobile|recipient|to|from|address|visitorName|visitorEmail|visitorPhone)$/i;

export function sanitizeQueueDiagnosticString(value: string): string {
  return redactCredentialText(value)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]')
    .replace(/(?<![\w+])\+?\d[\d\s().-]{7,}\d\b/g, '[PHONE]')
    .replace(/([?&](?:token|key|secret|signature|code)=)[^&\s]+/gi, '$1[REDACTED]')
    .slice(0, MAX_DIAGNOSTIC_STRING_LENGTH);
}

export function sanitizeQueueDiagnosticValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (typeof value === 'string') return sanitizeQueueDiagnosticString(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeQueueDiagnosticValue(item, depth + 1));
  }

  const entries = Object.entries(value as Record<string, unknown>).slice(0, 100);
  return Object.fromEntries(entries.map(([key, nested]) => {
    if (SECRET_KEY_PATTERN.test(key) || PII_KEY_PATTERN.test(key)) {
      return [key, '[REDACTED]'];
    }
    return [key, sanitizeQueueDiagnosticValue(nested, depth + 1)];
  }));
}
