import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(process.cwd(), '..', path), 'utf8');

describe('handoff and support ticket lifecycle', () => {
  it('resolves ownership, conversation status, and linked ticket in one transaction', () => {
    const service = read('server/services/agents/pipeline/HandoffService.ts');
    const mutation = read('server/services/SupportTicketMutation.ts');
    const tickets = read('server/services/SupportService.ts');
    expect(service).toContain('supportService.updateTicket(userId, handoff.supportTicketId');
    expect(service).toContain('expectedHandoffId: id');
    expect(tickets).toContain('withLockedSupportTicket');
    expect(tickets).toContain('await reconcileTicketLifecycle(tx, ticket, context)');
    expect(mutation).toMatch(/ticket\.status === ["']closed["'] \|\| context\.resumeAi === true/);
    expect(mutation).toContain("status='resolved', resolution=");
    expect(mutation).toContain('UPDATE outreach_conversations');
    expect(mutation).toContain("status='needs_human'");
    expect(mutation).toContain('UPDATE support_chat_sessions');
    expect(mutation).toContain("NOT IN ('opted_out','closed')");
  });

  it('exposes an explicit support-member AI takeover control', () => {
    const migration = read('server/migrations/236_add_handoff_ai_reply_control.js');
    const controller = read('server/controllers/supportHandoffController.ts');
    const routes = read('server/routes/supportMember.routes.ts');
    const memberWorkspace = read('client/src/app/support/tickets/[id]/page.tsx');
    expect(migration).toContain('ai_reply_enabled BOOLEAN NOT NULL DEFAULT TRUE');
    expect(controller).toContain('setAiReplyEnabled');
    expect(controller).toContain("action: enabled ? 'handoff.ai_replies_enabled' : 'handoff.human_takeover'");
    expect(routes).toContain("'/handoffs/:id/ai-replies'");
    expect(memberWorkspace).toContain('Pause AI replies & take over');
    expect(memberWorkspace).toContain('Enable AI replies');
    expect(memberWorkspace).toContain('AI replies are active again for the next customer message.');
  });

  it('backfills only unambiguous active handoff-to-ticket links', () => {
    const migration = read('server/migrations/201_repair_handoff_ticket_lifecycle.js');
    expect(migration).toContain('HAVING COUNT(*) = 1');
    expect(migration).toContain("h.status IN ('waiting', 'assigned', 'in_progress')");
    expect(migration).toContain('t.outreach_conversation_id = h.conversation_id');
  });
});
