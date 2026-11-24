import { describe, expect, it } from 'vitest';
import { pushSupportQueueHistory } from '@/lib/support-queue-query';
import { replaceSupportQueryHistory } from '@/lib/support-report';

describe('Support query history preserves domain recovery metadata', () => {
  it.each([pushSupportQueueHistory, replaceSupportQueryHistory])('keeps custom state while allowing Next to observe the new URL', write => {
    const recovery = { version: 2, scopes: { synthetic: { unresolved: true } } };
    history.replaceState({ __NA: true, _N: true, tree: 'synthetic', __asksalesFollowUpRecovery: recovery }, '', '/support/tickets');
    write('/support/tickets?channel=web#queue');
    expect(history.state).toEqual({ tree: 'synthetic', __asksalesFollowUpRecovery: recovery });
    expect(location.search).toBe('?channel=web'); expect(location.hash).toBe('#queue');
  });
});
