import { describe, expect, it } from '@jest/globals';
import { sendingAccountNotes } from '../mastra/utils/sendingAccountNotes.js';

describe('sending account notes for the outreach agent', () => {
  it('treats a ready account linked to another assistant as usable and says where to change it', () => {
    const [note] = sendingAccountNotes([{ label: 'sales@hotel.com', ready: true,
      assistant: { ready: true, assistantName: 'Hotel Sales Agent', setupUrl: '/dashboard/settings/outreach/assistants/a1' } }]);
    expect(note).toContain('sales@hotel.com is ready to send');
    expect(note).toContain('answered by the "Hotel Sales Agent" assistant');
    expect(note).toContain('does not stop it being used');
    expect(note).toContain('/dashboard/settings/outreach');
  });

  it('explains an account that cannot send and links to its setup', () => {
    const [note] = sendingAccountNotes([{ label: 'team@shop.com', ready: false, reason: 'Assign one active, published assistant to this exact business account and channel before sending.',
      assistant: { ready: false, assistantName: null } }]);
    expect(note).toBe("team@shop.com can't send yet: Assign one active, published assistant to this exact business account and channel before sending. Fix it at /dashboard/settings/outreach.");
  });

  it('returns nothing without accounts', () => {
    expect(sendingAccountNotes(undefined)).toEqual([]);
  });
});
