import { describe, expect, it } from '@jest/globals';
import crypto from 'node:crypto';
import {
  generateUserVerifyToken,
  generateUserWebhookToken,
  issueWebhookCapability,
  parseWebhookCapability,
  verifyWebhookCapability,
  WEBHOOK_CAPABILITY_LIFETIME_SECONDS,
} from '../utils/userWebhookTokens.js';

describe('user webhook credentials', () => {
  it('binds capabilities to a business, purpose, nonce and bounded expiry', () => {
    const now = 1_800_000_000;
    const token = issueWebhookCapability(42, 'nonce-a', 'sms', 7, now);
    expect(verifyWebhookCapability(token, 'nonce-a', 'sms', now)).toEqual({ userId: 42, businessProfileId: 7, purpose: 'sms', issuedAt: now, expiresAt: now + WEBHOOK_CAPABILITY_LIFETIME_SECONDS });
    expect(verifyWebhookCapability(token, 'nonce-b', 'sms', now)).toBeNull();
    expect(verifyWebhookCapability(token, 'nonce-a', 'sms_delivery', now)).toBeNull();
    expect(verifyWebhookCapability(token, 'nonce-a', 'sms', now + WEBHOOK_CAPABILITY_LIFETIME_SECONDS)).toBeNull();
    expect(parseWebhookCapability('a'.repeat(32), now)).toBeNull();
    expect(parseWebhookCapability(token.replace('v2.', 'v1.'), now)).toBeNull();
  });
  it('keeps legacy credentials deterministic when no rotation nonce exists', () => {
    expect(generateUserWebhookToken(42)).toBe(generateUserWebhookToken(42, null));
    expect(generateUserVerifyToken(42)).toBe(generateUserVerifyToken(42, null));
    expect(generateUserWebhookToken(42)).toBe(
      crypto
        .createHmac('sha256', 'test-only-webhook-secret-not-for-production')
        .update('user-42-webhook')
        .digest('hex')
        .substring(0, 32),
    );
  });

  it('uses separate fixed-length webhook and verification credentials', () => {
    const webhookToken = generateUserWebhookToken(42);
    const verifyToken = generateUserVerifyToken(42);

    expect(webhookToken).toMatch(/^[a-f0-9]{32}$/);
    expect(verifyToken).toMatch(/^[a-f0-9]{24}$/);
    expect(webhookToken).not.toContain(verifyToken);
  });

  it('invalidates both credentials when the nonce rotates', () => {
    expect(generateUserWebhookToken(42, 'rotation-a')).not.toBe(
      generateUserWebhookToken(42, 'rotation-b'),
    );
    expect(generateUserVerifyToken(42, 'rotation-a')).not.toBe(
      generateUserVerifyToken(42, 'rotation-b'),
    );
  });

  it('isolates credentials between users', () => {
    expect(generateUserWebhookToken(42, 'shared-nonce')).not.toBe(
      generateUserWebhookToken(43, 'shared-nonce'),
    );
  });
});
