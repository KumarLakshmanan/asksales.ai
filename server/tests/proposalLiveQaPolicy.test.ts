import { describe, expect, it } from '@jest/globals';
import {
  LIVE_PROPOSAL_QA_CONFIRMATION,
  liveProposalQaFrozenProviderTarget,
  liveProposalQaResumeDecision,
  sanitizeLiveProposalQaMessage,
  validateLiveProposalQaInput,
} from '../scripts/lib/proposalLiveQaPolicy.js';

const valid = {
  userId: 1,
  runId: 'controlled-qa-1',
  execute: true,
  allowExecution: true,
  confirmation: LIVE_PROPOSAL_QA_CONFIRMATION,
  recipientEmail: ' Controlled@Example.test ',
};

describe('controlled proposal live-QA policy', () => {
  it('requires all independent execution interlocks and normalizes the inbox', () => {
    expect(validateLiveProposalQaInput(valid)).toBe('controlled@example.test');
    expect(() => validateLiveProposalQaInput({ ...valid, allowExecution: false })).toThrow('Refusing a live email');
    expect(() => validateLiveProposalQaInput({ ...valid, confirmation: 'WRONG' })).toThrow('--confirm must equal');
    expect(() => validateLiveProposalQaInput({ ...valid, recipientEmail: '' })).toThrow('exact controlled inbox');
    expect(() => validateLiveProposalQaInput({ ...valid, recipientEmail: 'two@example.test,other@example.test' })).toThrow('one valid controlled inbox');
  });

  it('allows read-only planning without execution-only interlocks', () => {
    expect(validateLiveProposalQaInput({
      userId: 1,
      runId: 'plan-only',
      execute: false,
      allowExecution: false,
    })).toBe('');
  });

  it('prepares only when no durable delivery action exists', () => {
    expect(liveProposalQaResumeDecision()).toEqual({ action: 'prepare' });
  });

  it('polls a sent action and never prepares it again', () => {
    expect(liveProposalQaResumeDecision({ status: 'sent', providerMessageId: 'provider-123' }))
      .toEqual({ action: 'poll-confirmed-send' });
  });

  it('extracts the exact frozen Resend credential, domain, and sender', () => {
    expect(liveProposalQaFrozenProviderTarget({ metadata: { target: {
      credentialId: 17,
      providerAccountId: 'tenant.example',
      senderId: 29,
      senderEmail: 'sender@tenant.example',
    } } })).toEqual({
      credentialId: 17,
      providerAccountId: 'tenant.example',
      senderId: 29,
      senderEmail: 'sender@tenant.example',
    });
    expect(liveProposalQaFrozenProviderTarget({ metadata: { target: {
      credentialId: -1,
      senderId: 'invalid',
    } } })).toEqual({
      credentialId: undefined,
      providerAccountId: undefined,
      senderId: undefined,
      senderEmail: undefined,
    });
  });

  it.each(['sending', 'uncertain'])('stops without resending a %s action', (status) => {
    expect(liveProposalQaResumeDecision({ status, providerMessageId: null }))
      .toEqual({ action: 'stop', status: 'provider_outcome_uncertain' });
  });

  it.each(['failed', 'queued', 'sent'])('stops without resending an unusable %s action', (status) => {
    expect(liveProposalQaResumeDecision({ status, providerMessageId: null }))
      .toEqual({ action: 'stop', status: 'delivery_failed' });
  });

  it('removes recipient, sender, domain, token, and Resend-key material from errors', () => {
    const sanitized = sanitizeLiveProposalQaMessage(
      'Send qa@example.test through sender@tenant.test at tenant.test using secret-token and re_1234567890abcdef.',
      // Match runtime insertion order: recipient, domain, then full sender.
      ['qa@example.test', 'tenant.test', 'sender@tenant.test', 'secret-token'],
    );
    expect(sanitized).toBe('Send [redacted] through [redacted] at [redacted] using [redacted] and [redacted-credential].');
  });
});
