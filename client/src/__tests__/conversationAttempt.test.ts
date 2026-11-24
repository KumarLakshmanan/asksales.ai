import { afterEach, expect, it, vi } from 'vitest';
import { conversationAttempt, readConversationAttempt, finishConversationAttempt } from '@/lib/conversation-attempt';

afterEach(() => { sessionStorage.clear(); });
it('keeps identity on retry and module reload, including a first-session key', async () => {
  const attempt = conversationAttempt('reload-test','Hello');
  expect(conversationAttempt('reload-test','Hello')).toEqual(attempt);
  vi.resetModules();
  const reloaded = await import('@/lib/conversation-attempt');
  expect(reloaded.readConversationAttempt('reload-test')).toEqual(attempt);
  reloaded.finishConversationAttempt('reload-test',attempt.requestId);
  expect(reloaded.readConversationAttempt('reload-test')).toBeNull();
});
it('starts a new identity for edited content and does not clear a newer attempt from an older acknowledgement', () => {
  const first = conversationAttempt('edited','First'); const second = conversationAttempt('edited','Correction');
  expect(first.requestId).not.toBe(second.requestId);
  expect(first.clientSessionKey).toBe(second.clientSessionKey);
  finishConversationAttempt('edited',first.requestId); expect(readConversationAttempt('edited')).toEqual(second);
  finishConversationAttempt('edited',second.requestId); expect(readConversationAttempt('edited')).toBeNull();
});
it('ignores corrupt saved identity instead of sending a missing request ID', () => {
  sessionStorage.setItem('conversation-attempt:corrupt', JSON.stringify({text:'Hello',requestId:null}));
  expect(readConversationAttempt('corrupt')).toBeNull();
  expect(conversationAttempt('corrupt','Hello').requestId).toMatch(/^[a-f0-9-]{36}$/);
});
