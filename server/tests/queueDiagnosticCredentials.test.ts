import { describe, expect, it } from '@jest/globals';
import { sanitizeQueueDiagnosticString, sanitizeQueueDiagnosticValue } from '../utils/queueDiagnostics.js';
import { redactLogText } from '../utils/logRedaction.js';

const canaries = [
  ['postgresql://fixture:synthetic-password@localhost/fixture', 'synthetic-password'],
  ['sk-syntheticcredential', 'sk-syntheticcredential'],
  ['eyJabcdefghijk.abcdefghijklmnop.abcdefghijklmnop', 'eyJabcdefghijk.abcdefghijklmnop.abcdefghijklmnop'],
  ['https://example.test/?access_token=synthetic-query', 'synthetic-query'],
];

describe('canonical diagnostic credential redaction', () => {
  it('censors credential formats in free text for both logs and queue data', () => {
    for (const [text, secret] of canaries) {
      expect(redactLogText(text).includes(secret)).toBe(false);
      expect(sanitizeQueueDiagnosticString(text).includes(secret)).toBe(false);
      expect(JSON.stringify(sanitizeQueueDiagnosticValue({ details: text })).includes(secret)).toBe(false);
    }
  });
  it('preserves queue-specific PII markers, operational identifiers and limits', () => {
    expect(sanitizeQueueDiagnosticValue({ jobId: 'job-7', userId: 42, details: 'audit@example.test +919999999999', accessToken: 'synthetic-only' }))
      .toEqual({ jobId: 'job-7', userId: 42, details: '[EMAIL] [PHONE]', accessToken: '[REDACTED]' });
    expect(sanitizeQueueDiagnosticString('x'.repeat(11_000))).toHaveLength(10_000);
    expect(redactLogText('x'.repeat(11_000))).toHaveLength(8_000);
  });
});
