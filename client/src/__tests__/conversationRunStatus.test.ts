import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_PROCESSING_STALE_AFTER_MS,
  shouldResumeConversationProcessing,
} from '@/lib/conversation-run-status';

describe('shouldResumeConversationProcessing', () => {
  const now = Date.parse('2026-09-22T03:30:00.000Z');

  it('restores processing for a recent running workflow', () => {
    expect(shouldResumeConversationProcessing({
      status: 'running',
      updatedAt: new Date(now - 30_000).toISOString(),
    }, now)).toBe(true);
  });

  it('clears stale, terminal, and timestamp-less runs', () => {
    expect(shouldResumeConversationProcessing({ status: 'running', updatedAt: now - CONVERSATION_PROCESSING_STALE_AFTER_MS - 1 }, now)).toBe(false);
    expect(shouldResumeConversationProcessing({ status: 'succeeded', updatedAt: now }, now)).toBe(false);
    expect(shouldResumeConversationProcessing({ status: 'running' }, now)).toBe(false);
  });

  it('tolerates small clock skew but rejects future-dated stale runs', () => {
    expect(shouldResumeConversationProcessing({ status: 'running', updatedAt: now + 20_000 }, now)).toBe(true);
    expect(shouldResumeConversationProcessing({ status: 'running', updatedAt: now + 31_000 }, now)).toBe(false);
  });
});
