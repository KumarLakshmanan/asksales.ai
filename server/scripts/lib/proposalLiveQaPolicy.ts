import { asRecord as object } from '../../../shared/records.js';
import { parsePositiveIdOrUndefined as positiveInteger } from '../../utils/paramParsers.js';
import { EMAIL_ADDRESS_PATTERN as EMAIL_PATTERN } from '../../../shared/emailAddress.js';
export const LIVE_PROPOSAL_QA_CONFIRMATION = 'SEND_CONTROLLED_PROPOSAL_QA';
export const LIVE_PROPOSAL_QA_RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,63}$/;

export type LiveProposalQaInput = {
  userId: number;
  runId: string;
  execute: boolean;
  allowExecution: boolean;
  confirmation?: string;
  recipientEmail?: string;
};

export function validateLiveProposalQaInput(input: LiveProposalQaInput): string {
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0
    || !LIVE_PROPOSAL_QA_RUN_ID_PATTERN.test(input.runId)) {
    throw new Error('Usage: --user-id <positive integer> --run-id <6-64 lowercase letters, digits, or hyphens> [--execute --confirm SEND_CONTROLLED_PROPOSAL_QA]');
  }
  const recipientEmail = String(input.recipientEmail || '').trim().toLowerCase();
  if (recipientEmail && !EMAIL_PATTERN.test(recipientEmail)) {
    throw new Error('PROPOSAL_LIVE_QA_EMAIL must contain one valid controlled inbox address.');
  }
  if (input.execute && !input.allowExecution) {
    throw new Error('Refusing a live email. Set PROPOSAL_LIVE_QA_ALLOW_EXECUTE=true together with --execute and the confirmation phrase.');
  }
  if (input.execute && input.confirmation !== LIVE_PROPOSAL_QA_CONFIRMATION) {
    throw new Error(`--confirm must equal ${LIVE_PROPOSAL_QA_CONFIRMATION}.`);
  }
  if (input.execute && !recipientEmail) {
    throw new Error('Set PROPOSAL_LIVE_QA_EMAIL to the exact controlled inbox before executing.');
  }
  return recipientEmail;
}

export type LiveProposalQaDeliveryAction = {
  status: string;
  providerMessageId?: string | null;
};

export type LiveProposalQaProviderPreference = {
  credentialId?: number;
  providerAccountId?: string;
  senderId?: number;
  senderEmail?: string;
};

export function liveProposalQaFrozenProviderTarget(
  actionPayload: unknown,
): LiveProposalQaProviderPreference {
  const target = object(object(object(actionPayload).metadata).target);
  return {
    credentialId: positiveInteger(target.credentialId),
    providerAccountId: typeof target.providerAccountId === 'string' ? target.providerAccountId : undefined,
    senderId: positiveInteger(target.senderId),
    senderEmail: typeof target.senderEmail === 'string' ? target.senderEmail : undefined,
  };
}

export type LiveProposalQaResumeDecision =
  | { action: 'prepare' }
  | { action: 'poll-confirmed-send' }
  | { action: 'stop'; status: 'provider_outcome_uncertain' | 'delivery_failed' };

/**
 * A durable action is the send boundary. Once one exists, this policy never
 * chooses `prepare`, so restarting the QA command cannot make another provider
 * call for the same proposal/run id.
 */
export function liveProposalQaResumeDecision(
  action?: LiveProposalQaDeliveryAction,
): LiveProposalQaResumeDecision {
  if (!action) return { action: 'prepare' };
  if (action.status === 'sent' && action.providerMessageId) {
    return { action: 'poll-confirmed-send' };
  }
  if (['sending', 'uncertain'].includes(action.status)) {
    return { action: 'stop', status: 'provider_outcome_uncertain' };
  }
  return { action: 'stop', status: 'delivery_failed' };
}

export function sanitizeLiveProposalQaMessage(
  message: string,
  sensitiveValues: Iterable<string>,
): string {
  let result = message;
  // Replace longer values first so a domain cannot partially mask a sender
  // address and leave its local part visible.
  const orderedValues = [...sensitiveValues].filter(Boolean).sort((left, right) => right.length - left.length);
  for (const value of orderedValues) {
    if (value) result = result.replaceAll(value, '[redacted]');
  }
  return result
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\bre_[A-Za-z0-9_-]{12,}\b/g, '[redacted-credential]');
}
