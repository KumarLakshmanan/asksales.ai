/** Only an explicit Gmail rejection is safe to retry after a send attempt. */
export function gmailSendError(error: unknown, deliveryAttempted: boolean, providerAccepted: boolean) {
  const failure = error as {
    message?: string;
    response?: { status?: number; data?: { error?: { message?: string; errors?: Array<{ reason?: string }> } }; headers?: { get?: (name: string) => unknown; [key: string]: unknown } };
  };
  const response = failure?.response;
  const status = Number(response?.status);
  const providerError = response?.data?.error;
  const rejected = !providerAccepted && deliveryAttempted && status >= 400 && status < 500 && Boolean(providerError);
  const retryable = rejected && (status === 429 || (status === 403 && providerError?.errors?.some(
    entry => entry.reason === 'userRateLimitExceeded' || entry.reason === 'rateLimitExceeded',
  ) === true));
  let retryAt: string | undefined;
  if (retryable) {
    const now = Date.now();
    const headers = response?.headers;
    const retryAfter = headers?.get?.('retry-after') ?? headers?.['retry-after'] ?? headers?.['Retry-After'];
    const value = typeof retryAfter === 'string' || typeof retryAfter === 'number' ? String(retryAfter).trim() : '';
    const headerTime = value ? (/^\d+(?:\.\d+)?$/.test(value) ? now + Number(value) * 1000 : Date.parse(value)) : NaN;
    const message = providerError?.message || failure?.message || '';
    const timestamp = message.match(/retry after\s+(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))/i)?.[1];
    const messageTime = timestamp ? Date.parse(timestamp) : NaN;
    const candidates = [headerTime, messageTime].filter(time => Number.isFinite(time) && time > now && time <= 8.64e15);
    if (candidates.length) retryAt = new Date(Math.max(...candidates)).toISOString();
  }
  return {
    success: false as const,
    error: failure?.message || providerError?.message || 'Failed to send email',
    deliveryAttempted,
    outcomeUncertain: deliveryAttempted && !rejected,
    retryable,
    retryAt,
  };
}
