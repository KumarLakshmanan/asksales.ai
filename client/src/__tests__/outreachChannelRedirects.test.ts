import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ redirect: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
import { redirectOutreachInbox } from '@/components/outreach/inbox/redirectInbox';

describe('shared channel inbox links', () => {
  it.each(['email', 'sms', 'whatsapp', 'instagram', 'facebook'] as const)('preserves the reviewed %s conversation and contact', async channel => {
    await redirectOutreachInbox(channel, Promise.resolve({ conversationId: '12', leadId: '3' }));
    expect(mocks.redirect).toHaveBeenLastCalledWith(`/dashboard/outreach/inbox?channel=${channel}&thread=conversation%3A12&leadId=3`);
  });
  it('does not carry malformed or repeated identifiers into the inbox', async () => {
    await redirectOutreachInbox('email', Promise.resolve({ conversationId: ['12', '13'], leadId: '-3' }));
    expect(mocks.redirect).toHaveBeenLastCalledWith('/dashboard/outreach/inbox?channel=email');
  });
});
