import { AsyncLocalStorage } from 'node:async_hooks';

// Narrow, code-only exceptions for operator reports and operational alerts.
// Never populate this context from an HTTP body, campaign or queue payload.
const internalEmail = new AsyncLocalStorage<'operator_report' | 'ad_owner_alert'>();
export const isInternalEmailDelivery = () => Boolean(internalEmail.getStore());
export function withInternalEmailDelivery<T>(purpose: 'operator_report' | 'ad_owner_alert', work: () => T): T {
  return internalEmail.run(purpose, work);
}
