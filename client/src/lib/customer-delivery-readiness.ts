import { ApiError } from './api-client';
import type { CustomerDeliveryReadiness } from '../../../shared/customerDeliveryReadiness';

export function customerDeliveryFailure(error: unknown, context: { channel?: string; accountId?: string } = {}): CustomerDeliveryReadiness | undefined {
  if (!(error instanceof ApiError) || !error.data || typeof error.data !== 'object') return;
  const data = error.data as Record<string, unknown>;
  if (data.code !== 'ASSISTANT_SETUP_REQUIRED') return;
  return {
    ready: false,
    code: 'ASSISTANT_SETUP_REQUIRED',
    error: typeof data.error === 'string' ? data.error : error.message,
    reason: typeof data.reason === 'string' ? data.reason : undefined,
    setupUrl: typeof data.setupUrl === 'string' && /^\/dashboard\/settings\/outreach(?:[/?#]|$)/.test(data.setupUrl) ? data.setupUrl : '/dashboard/settings/outreach',
    assistantId: typeof data.assistantId === 'string' ? data.assistantId : undefined,
    accountId: context.accountId || '',
    channel: context.channel || '',
  };
}
