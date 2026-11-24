/** Pure receipt decisions shared by server claims and review controls.
 * These functions do not grant ownership, permissions, execution or billing authority. */
export function isRetrySafeExecutionResult(result: unknown): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const record = result as Record<string, unknown>;
  const output = record.output && typeof record.output === 'object' && !Array.isArray(record.output)
    ? record.output as Record<string, unknown> : undefined;
  // Only the canonical receipt/envelope can authorize retry. An optimistic
  // hint must never override evidence that work was accepted or is uncertain.
  if (record.retrySafe !== true && output?.retrySafe !== true) return false;
  const unsafeStatuses = new Set([
    'queued', 'queued_partial', 'running', 'processing', 'pending',
    'needs_attention', 'partial_success', 'succeeded', 'success', 'completed',
    'sent', 'delivered', 'published', 'active', 'provider_created',
    'provider_succeeded', 'scheduled', 'claimed', 'retryable_failed',
    'uncertain', 'ambiguous', 'reconciliation_required',
  ]);
  const acceptedCountKeys = [
    'acknowledgedQueueCount', 'queuedCount', 'successCount',
    'sent', 'sentCount', 'delivered', 'deliveredCount', 'publishedCount',
  ];
  const seen = new Set<object>();
  const pending: Array<{ value: unknown; depth: number }> = [{ value: record, depth: 0 }];
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (!value || typeof value !== 'object') continue;
    if (depth > 8 || seen.size >= 1000 || seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > 1000) return false;
      pending.push(...value.map(item => ({ value: item, depth: depth + 1 })));
      continue;
    }
    const receipt = value as Record<string, unknown>;
    if (receipt.retrySafe === false || receipt.ambiguous === true
      || receipt.sideEffectsMayHaveOccurred === true || receipt.manualReviewRequired === true || receipt.success === true
      || receipt.outcomeUncertain === true || receipt.reconciliationRequired === true
      || (typeof receipt.status === 'string' && unsafeStatuses.has(receipt.status.toLowerCase()))
      || acceptedCountKeys.some(key => (typeof receipt[key] === 'number' || typeof receipt[key] === 'string')
        && Number(receipt[key]) > 0)) return false;
    // Traverse structured action receipts only, never arbitrary generated copy,
    // request inputs, messages or prose that happens to contain a status field.
    for (const key of ['output', 'results', 'deliveryProgress']) {
      if (receipt[key]) pending.push({ value: receipt[key], depth: depth + 1 });
    }
    if (receipt.platforms && typeof receipt.platforms === 'object') {
      const platforms = Object.values(receipt.platforms);
      if (platforms.length > 1000) return false;
      pending.push(...platforms.map(item => ({ value: item, depth: depth + 1 })));
    }
  }
  return true;
}

export interface WidgetReviewReceipt {
  status: string;
  executionResult?: unknown;
  executionAttemptCount?: number;
}

function canDiscardReceipt(review: WidgetReviewReceipt): boolean {
  if (isRetrySafeExecutionResult(review.executionResult)) return true;
  const receipt = review.executionResult;
  if ((review.executionAttemptCount ?? 0) !== 0) return false;
  if (receipt == null) return true;
  if (typeof receipt !== 'object' || Array.isArray(receipt)) return false;
  if (Object.keys(receipt).length === 0) return true;
  const record = receipt as Record<string, unknown>;
  // Existing revision tombstones record a row-locked replacement before any
  // attempt. Preserve that distinct history without trusting execution hints.
  return record.executed === false && record.reason === 'review_revised'
    && Number.isSafeInteger(record.supersededByWidgetId) && Number(record.supersededByWidgetId) > 0
    && isRetrySafeExecutionResult({ retrySafe: true, ...record });
}

/** An unstarted review or a confirmed pre-effect failure can be edited/cancelled.
 * Retain every other receipt, including malformed legacy state, for reconciliation. */
export function canEditWidgetReview(review: WidgetReviewReceipt): boolean {
  if (review.status === 'failed') return isRetrySafeExecutionResult(review.executionResult);
  return ['active', 'draft'].includes(review.status) && canDiscardReceipt(review);
}

export const canCancelWidgetReview = canEditWidgetReview;

export function canDeleteWidgetReview(review: WidgetReviewReceipt): boolean {
  return ['active', 'draft', 'cancelled'].includes(review.status) && canDiscardReceipt(review);
}
