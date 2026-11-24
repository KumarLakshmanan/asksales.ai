import { describe, expect, it } from '@jest/globals';
import { resolveSupportNotificationEmailSender } from '../services/SupportNotificationEmailConfiguration.js';

describe('support notification sender configuration', () => {
  const resend = { apiKey: 'test-only' };
  it('uses the existing Resend-backed SMTP sender instead of inventing an unverified domain', () => {
    expect(resolveSupportNotificationEmailSender(resend, {
      config: { provider: 'resend', fromEmail: 'support@example.com' },
    }, {})).toBe('support@example.com');
  });
  it('preserves explicit notification overrides and the platform sender precedence', () => {
    const configured = { ...resend, config: { fromEmail: 'platform@example.com' } };
    expect(resolveSupportNotificationEmailSender(configured, null, {
      SUPPORT_NOTIFICATION_FROM_EMAIL: 'alerts@example.com',
    })).toBe('alerts@example.com');
    expect(resolveSupportNotificationEmailSender(configured, null, {
      DEFAULT_FROM_EMAIL: 'fallback@example.com',
    })).toBe('platform@example.com');
  });
  it('fails closed for missing credentials, missing sender, unrelated SMTP, and header injection', () => {
    expect(resolveSupportNotificationEmailSender(null, null, { DEFAULT_FROM_EMAIL: 'a@example.com' })).toBeNull();
    expect(resolveSupportNotificationEmailSender(resend, null, {})).toBeNull();
    expect(resolveSupportNotificationEmailSender(resend, {
      config: { provider: 'other', fromEmail: 'foreign@example.com' },
    }, {})).toBeNull();
    expect(resolveSupportNotificationEmailSender(resend, null, {
      SUPPORT_NOTIFICATION_FROM_EMAIL: 'a@example.com\r\nBcc: b@example.com',
    })).toBeNull();
  });
});
