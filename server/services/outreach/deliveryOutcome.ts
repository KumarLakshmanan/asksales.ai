export interface DeliveryOutcomeEvidence {
  deliveryAttempted?: boolean;
  outcomeUnknown?: boolean;
  outcomeUncertain?: boolean;
}

/**
 * Missing delivery evidence is uncertain by default. A provider adapter may
 * explicitly prove that it never crossed the send boundary or rejected the
 * request, in which case the message is safe to mark failed and retry.
 */
export function deliveryOutcomeIsUncertain(evidence: DeliveryOutcomeEvidence): boolean {
  return evidence.deliveryAttempted !== false
    && evidence.outcomeUnknown !== false
    && evidence.outcomeUncertain !== false;
}

/** Provider IDs are opaque tokens, distinct from locally assigned RFC headers. */
export function providerMessageId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && !/[\s<>]/.test(value) ? value : undefined;
}

/** Keep the adapter's authoritative boundary evidence through queue and HTTP paths. */
export function toOutreachEmailResult(result: DeliveryOutcomeEvidence & {
  success: boolean;
  messageId?: string;
  providerMessageId?: string;
  rfcMessageId?: string;
  threadId?: string;
  error?: string;
  retryable?: boolean;
  retryAt?: string;
  code?: string;
  reason?: string;
  setupUrl?: string;
  assistantId?: string;
}) {
  const receipt = providerMessageId(result.providerMessageId ?? result.messageId);
  if (result.success && !receipt) {
    return { success: false, error: 'The email provider did not return an acceptance receipt. Review provider history before retrying.',
      deliveryAttempted: true, outcomeUnknown: true, retryable: false };
  }
  return {
    code: result.code,
    reason: result.reason,
    setupUrl: result.setupUrl,
    assistantId: result.assistantId,
    success: result.success,
    externalMessageId: result.messageId,
    providerMessageId: receipt,
    rfcMessageId: result.rfcMessageId,
    threadId: result.threadId,
    error: result.error,
    deliveryAttempted: result.deliveryAttempted,
    outcomeUnknown: result.outcomeUnknown ?? result.outcomeUncertain,
    retryable: result.retryable,
    retryAt: result.retryAt,
  };
}
