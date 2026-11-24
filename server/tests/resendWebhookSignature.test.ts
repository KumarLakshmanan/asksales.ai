import crypto from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { verifyResendSvixSignature } from '../controllers/resendWebhookController.js';

const NOW_MS = Date.parse('2026-07-19T00:00:00.000Z');
const TIMESTAMP = String(Math.floor(NOW_MS / 1000));
const SECRET_BYTES = Buffer.from('resend-webhook-test-secret');
const SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;
const PAYLOAD = JSON.stringify({ type: 'email.delivered', data: { email_id: 'email-1' } });

function headers(payload = PAYLOAD, timestamp = TIMESTAMP): Record<string, string> {
  const id = 'msg_test_1';
  const signature = crypto
    .createHmac('sha256', SECRET_BYTES)
    .update(`${id}.${timestamp}.${payload}`)
    .digest('base64');
  return {
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': `v1,${signature}`,
  };
}

describe('verifyResendSvixSignature', () => {
  it('accepts the exact recent raw payload', () => {
    expect(verifyResendSvixSignature(PAYLOAD, headers(), SECRET, NOW_MS)).toBe(true);
  });

  it('rejects a payload changed after signing', () => {
    expect(verifyResendSvixSignature(`${PAYLOAD} `, headers(), SECRET, NOW_MS)).toBe(false);
  });

  it('rejects stale signed requests to bound replay risk', () => {
    const staleTimestamp = String(Math.floor((NOW_MS - 6 * 60 * 1000) / 1000));
    expect(verifyResendSvixSignature(PAYLOAD, headers(PAYLOAD, staleTimestamp), SECRET, NOW_MS)).toBe(false);
  });

  it('rejects missing and malformed signatures without throwing', () => {
    expect(verifyResendSvixSignature(PAYLOAD, {}, SECRET, NOW_MS)).toBe(false);
    expect(verifyResendSvixSignature(PAYLOAD, {
      'svix-id': 'msg_test_1',
      'svix-timestamp': TIMESTAMP,
      'svix-signature': 'v1,short',
    }, SECRET, NOW_MS)).toBe(false);
  });
});
