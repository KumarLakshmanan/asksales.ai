import crypto from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import {
  linkedInChallengeResponse,
  twitterChallengeResponse,
  verifyLinkedInWebhookSignature,
  verifyTwitterWebhookSignature,
} from '../utils/socialWebhookSignatures.js';

const rawBody = Buffer.from('{"event":"customer reply","id":"provider-1"}', 'utf8');

describe('official social webhook signatures', () => {
  it('accepts only the X signature over the exact raw request body', () => {
    const secret = 'twitter-consumer-secret';
    const signature = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('base64')}`;

    expect(verifyTwitterWebhookSignature(rawBody, signature, secret)).toBe(true);
    expect(verifyTwitterWebhookSignature(Buffer.from(`${rawBody} `), signature, secret)).toBe(false);
    expect(verifyTwitterWebhookSignature(rawBody, 'sha256=invalid', secret)).toBe(false);
    expect(twitterChallengeResponse('crc-token', secret)).toBe(
      `sha256=${crypto.createHmac('sha256', secret).update('crc-token').digest('base64')}`,
    );
  });

  it('accepts only LinkedIn X-LI-Signature over its documented string-to-sign', () => {
    const secret = 'linkedin-client-secret';
    const signature = crypto
      .createHmac('sha256', secret)
      .update(Buffer.concat([Buffer.from('hmacsha256='), rawBody]))
      .digest('hex');

    expect(verifyLinkedInWebhookSignature(rawBody, signature, secret)).toBe(true);
    expect(verifyLinkedInWebhookSignature(Buffer.from(`${rawBody} `), signature, secret)).toBe(false);
    expect(verifyLinkedInWebhookSignature(rawBody, 'invalid', secret)).toBe(false);
    expect(linkedInChallengeResponse('challenge-code', secret)).toBe(
      crypto.createHmac('sha256', secret).update('challenge-code').digest('hex'),
    );
  });

  it('rejects missing raw bytes, signatures, and secrets', () => {
    expect(verifyTwitterWebhookSignature(undefined, 'signature', 'secret')).toBe(false);
    expect(verifyLinkedInWebhookSignature(rawBody, undefined, 'secret')).toBe(false);
    expect(verifyLinkedInWebhookSignature(rawBody, 'signature', '')).toBe(false);
  });
});
