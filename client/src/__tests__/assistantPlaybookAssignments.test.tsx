import { describe, expect, it } from 'vitest';
import { emptyAssistantDraft } from '@/lib/outreach-assistants';
import { playbookAssignments } from '@/components/outreach/assistants/AssistantJourneyPickers';
import { playbookCountLabel } from '@/components/outreach/assistants/AssistantJourneys';

const draft = () => ({ ...emptyAssistantDraft(), agentType: 'tech_support', bindings: [{ channel: 'web' as const, surface: 'private' as const, accountId: 'team:1' }] });

describe('playbook assignments from the picker', () => {
  it('copies each playbook’s published routing instead of tying every playbook at any intent', () => {
    const rows = playbookAssignments([
      { id: 9, name: 'Troubleshooting', channels: ['web'], defaultAssignments: [{ intent: 'support_request', priority: 120 }] },
      { id: 10, name: 'Ticket status', channels: ['web'], defaultAssignments: [{ intent: 'ticket_status', priority: 130 }] },
    ], draft());
    expect(rows).toEqual([
      { playbookId: 9, channel: 'web', surface: 'private', intent: 'support_request', priority: 120 },
      { playbookId: 10, channel: 'web', surface: 'private', intent: 'ticket_status', priority: 130 },
    ]);
  });
  it('falls back to any intent and skips assignments that already exist', () => {
    const current = draft();
    current.playbooks = { mode: 'selected', assignments: [{ playbookId: 9, channel: 'web', surface: 'private', intent: null, priority: 100 }] };
    expect(playbookAssignments([{ id: 9, name: 'Troubleshooting', channels: ['web'] }], current)).toEqual([]);
    expect(playbookAssignments([{ id: 11, name: 'Email only', channels: ['email'] }], current)).toEqual([]);
  });
  it('counts playbooks, not routing rows', () => {
    expect(playbookCountLabel([{ playbookId: 9 }])).toBe('1 playbook assigned');
    expect(playbookCountLabel([{ playbookId: 9 }, { playbookId: 9 }, { playbookId: 10 }])).toBe('2 playbooks assigned · 3 routes');
  });
});
