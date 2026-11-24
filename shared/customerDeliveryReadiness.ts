import type { AssistantProvenance } from './outreachAssistants.js';

export interface CustomerDeliveryReadiness {
  ready: boolean;
  code?: 'ASSISTANT_SETUP_REQUIRED';
  reason?: string;
  error?: string;
  setupUrl: string;
  assistantId?: string;
  assistantName?: string;
  accountId: string;
  channel: string;
  provenance?: AssistantProvenance;
}
