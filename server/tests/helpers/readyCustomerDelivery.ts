import { jest } from '@jest/globals';
import type { AssistantProvenance } from '../../../shared/outreachAssistants.js';

/** Transport/receipt suites isolate provider behavior with explicit ready setup.
 * customerDeliveryGate/socialCustomerDeliveryBoundary exercise the real gate. */
export const readyDeliveryReceipt: AssistantProvenance = { assistantId: '11111111-1111-4111-8111-111111111111',
  bindingId: 1, bindingVersion: 1, revision: 1, businessProfileId: 101,
  channel: 'email', surface: 'private', accountId: 'sales@example.test' };
export function installReadyCustomerDeliveryMock() {
  class SetupError extends Error { readonly code = 'ASSISTANT_SETUP_REQUIRED'; readonly status = 409; readonly deliveryAttempted = false; readonly outcomeUncertain = false; readonly retryable = false; readonly setupUrl = '/dashboard/settings/outreach'; constructor(readonly reason: string, message: string) { super(message); } }
  jest.unstable_mockModule('../../services/assistants/CustomerDeliveryGate.js', () => ({
    CustomerDeliverySetupError: SetupError,
    assertCustomerDeliveryRuntime: () => undefined,
    assertCustomerDeliveryReady: async (input: Record<string, any>) => input.expected || { ...readyDeliveryReceipt, channel: input.channel, accountId: input.accountId, surface: input.surface || 'private' },
    customerDeliveryReadiness: async (input: Record<string, any>) => ({ ready: true, setupUrl: '/dashboard/settings/outreach', ...input }),
    currentCustomerDeliveryReceipt: () => undefined,
    withCustomerDeliveryReceipt: (_receipt: unknown, work: () => unknown) => work(),
    deliverySetupFailure: (error: unknown) => error instanceof SetupError ? { success: false, code: error.code, reason: error.reason, error: error.message, setupUrl: error.setupUrl, deliveryAttempted: false, outcomeUncertain: false, retryable: false } : undefined,
    throwIfCustomerDeliverySetupRequired: (result: { code?: string; reason?: string; error?: string }) => {
      if (result.code === 'ASSISTANT_SETUP_REQUIRED') throw new SetupError(result.reason || 'assignment_required', result.error || 'Assistant setup required.');
    },
  }));
}

/** The worker adapter tests mock every policy/admission boundary explicitly. */
export function installReadyCustomerJobMock() {
  jest.unstable_mockModule('../../services/assistants/CustomerDeliveryJobs.js', () => ({
    runCustomerDeliveryJob: (_name: string, _data: unknown, work: () => unknown) => work(),
    holdCustomerDeliveryJob: async () => undefined,
    admitCustomerDeliveryJob: async (_name: string, data: unknown) => data,
    isCustomerDeliveryJob: () => true,
  }));
}
