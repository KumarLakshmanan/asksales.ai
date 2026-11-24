/**
 * Phase 3.15 / TEST-001: RazorpayService.verifyPayment unit tests.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import crypto from 'crypto';
import { razorpayService } from '../services/RazorpayService.js';

describe('RazorpayService.verifyPayment', () => {
  const KEY_SECRET = 'unit-test-key-secret';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let getConfigSpy: any;

  beforeEach(() => {
    jest.clearAllMocks();
    if (!getConfigSpy) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getConfigSpy = jest.spyOn(razorpayService as any, 'getConfig');
    }
  });

  it('returns true for a valid signature', async () => {
    getConfigSpy.mockResolvedValue({ keyId: 'rzp_test', keySecret: KEY_SECRET });
    const orderId = 'order_123';
    const paymentId = 'pay_456';
    const expected = crypto
      .createHmac('sha256', KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    const result = await razorpayService.verifyPayment(orderId, paymentId, expected);
    expect(result).toBe(true);
  });

  it('returns false for a tampered signature', async () => {
    getConfigSpy.mockResolvedValue({ keyId: 'rzp_test', keySecret: KEY_SECRET });
    const result = await razorpayService.verifyPayment('order_1', 'pay_1', 'deadbeef'.repeat(8));
    expect(result).toBe(false);
  });

  it('returns false when config is missing', async () => {
    getConfigSpy.mockResolvedValue(null);
    const result = await razorpayService.verifyPayment('order_1', 'pay_1', 'a'.repeat(64));
    expect(result).toBe(false);
  });

  it('returns false when signature length differs from expected', async () => {
    getConfigSpy.mockResolvedValue({ keyId: 'rzp_test', keySecret: KEY_SECRET });
    // "ab" is 2 hex chars (1 byte) — different length than the 32-byte SHA-256 output
    const result = await razorpayService.verifyPayment('order_1', 'pay_1', 'ab');
    expect(result).toBe(false);
  });
});
