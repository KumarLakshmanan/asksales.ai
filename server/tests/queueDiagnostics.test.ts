import { describe, expect, it } from '@jest/globals';
import {
  sanitizeQueueDiagnosticString,
  sanitizeQueueDiagnosticValue,
} from '../utils/queueDiagnostics.js';

describe('queue diagnostics sanitization', () => {
  it('redacts nested credentials and common PII before persistence', () => {
    const sanitized = sanitizeQueueDiagnosticValue({
      apiKey: 'provider-secret',
      nested: {
        visitorEmail: 'buyer@example.com',
        message: 'Contact buyer@example.com or +91 98765 43210',
      },
    }) as Record<string, unknown>;

    expect(sanitized.apiKey).toBe('[REDACTED]');
    expect(sanitized.nested).toEqual({
      visitorEmail: '[REDACTED]',
      message: 'Contact [EMAIL] or [PHONE]',
    });
  });

  it('redacts authorization values and sensitive query parameters in errors', () => {
    const sanitized = sanitizeQueueDiagnosticString(
      'Bearer abc.def request failed at https://provider.test/callback?token=top-secret',
    );
    expect(sanitized).not.toContain('abc.def');
    expect(sanitized).not.toContain('top-secret');
  });

  it('bounds diagnostic depth and collection size', () => {
    let deeplyNested: unknown = 'terminal';
    for (let depth = 0; depth < 8; depth += 1) {
      deeplyNested = { nested: deeplyNested };
    }
    const sanitized = sanitizeQueueDiagnosticValue(deeplyNested);
    expect(JSON.stringify(sanitized)).toContain('[TRUNCATED]');
    expect((sanitizeQueueDiagnosticValue(Array.from({ length: 150 }, (_, index) => index)) as unknown[]))
      .toHaveLength(100);
  });
});
