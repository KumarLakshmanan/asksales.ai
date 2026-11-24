import { describe, expect, it } from '@jest/globals';
import { deliveryOutcomeIsUncertain, toOutreachEmailResult } from '../services/outreach/deliveryOutcome.js';

describe('provider delivery outcome evidence', () => {
  it('keeps missing evidence in manual review', () => {
    expect(deliveryOutcomeIsUncertain({})).toBe(true);
    expect(deliveryOutcomeIsUncertain({ deliveryAttempted: true })).toBe(true);
    expect(deliveryOutcomeIsUncertain({ outcomeUnknown: true })).toBe(true);
  });

  it('marks explicit pre-provider failures and provider rejections as failed, not uncertain', () => {
    expect(deliveryOutcomeIsUncertain({ deliveryAttempted: false })).toBe(false);
    expect(deliveryOutcomeIsUncertain({ deliveryAttempted: true, outcomeUncertain: false })).toBe(false);
    expect(deliveryOutcomeIsUncertain({ outcomeUnknown: false })).toBe(false);
  });

  it('keeps structured rejection and preflight evidence through email translation', () => {
    expect(toOutreachEmailResult({ success: false, error: 'Rejected', deliveryAttempted: true,
      outcomeUncertain: false, retryable: true })).toMatchObject({ success: false,
      error: 'Rejected', deliveryAttempted: true, outcomeUnknown: false, retryable: true });
    expect(deliveryOutcomeIsUncertain(toOutreachEmailResult({ success: false, deliveryAttempted: false }))).toBe(false);
  });

  it('preserves the provider cooldown through canonical email translation', () => {
    const retryAt = '2026-10-17T08:00:00.000Z';
    expect(toOutreachEmailResult({ success: false, deliveryAttempted: true,
      outcomeUncertain: false, retryable: true, retryAt })).toMatchObject({
      success: false, outcomeUnknown: false, retryable: true, retryAt,
    });
  });

  it.each([undefined, '', ' ', '<generated@example.test>'])('never treats missing/native-invalid ID %s or a local RFC header as acceptance', id => {
    const mapped = toOutreachEmailResult({ success: true, providerMessageId: id, rfcMessageId: '<generated@example.test>' });
    expect(mapped).toMatchObject({ success: false, outcomeUnknown: true, retryable: false });
  });

  it('preserves both ID namespaces and uncertainty without inventing delivery', () => {
    expect(toOutreachEmailResult({ success: true, messageId: '<header@example.test>',
      providerMessageId: 'provider-id', rfcMessageId: '<header@example.test>', threadId: 'thread' }))
      .toMatchObject({ success: true, externalMessageId: '<header@example.test>', providerMessageId: 'provider-id', threadId: 'thread' });
    expect(deliveryOutcomeIsUncertain(toOutreachEmailResult({ success: false, deliveryAttempted: true, outcomeUncertain: true }))).toBe(true);
  });
});
