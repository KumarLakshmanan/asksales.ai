import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(process.cwd(), '..', path), 'utf8');

describe('unified support ticket workspace', () => {
  it('keeps tickets canonical and redirects the legacy handoff queue', () => {
    const sidebar = read('client/src/lib/supportSidebarConfig.tsx');
    const redirect = read('client/src/app/support/handoffs/page.tsx');
    expect(sidebar).not.toContain('label: "AI Handoffs"');
    expect(sidebar).toContain('{ label: "Queue", path: "/support/tickets"');
    expect(sidebar).toContain('{ label: "Pipeline", path: "/support/tickets/pipeline"');
    expect(redirect).toContain('redirect("/support/tickets?handoff=active")');
  });

  it('provides scoped claim, timeline, summary, and optimistic version contracts', () => {
    const routes = read('server/routes/supportMember.routes.ts');
    const controller = read('server/controllers/supportMemberController.ts');
    const service = read('server/services/SupportTicketWorkspaceService.ts');
    expect(routes).toContain("router.post('/tickets/:id/claim'");
    expect(routes).toContain("router.get('/tickets/:id/timeline'");
    expect(routes).toContain("router.post('/tickets/:id/summary/refresh'");
    expect(controller).toContain("scope === 'unassigned'");
    expect(controller).toContain('TICKET_VERSION_CONFLICT');
    expect(read('server/services/SupportService.ts')).toContain('TICKET_CLAIM_CONFLICT');
    expect(controller).toContain('supportService.claimTicket');
    expect(controller).toContain('TICKET_ASSIGNMENT_CONFLICT');
    expect(controller).toContain("receipt.reader_kind='member'");
    expect(service).toContain("type SupportTimelineEventType = 'customer' | 'agent' | 'internal_note' | 'system'");
    expect(service).toContain("'[Restricted content — reveal with an audited support action]'");
    expect(service).toContain('nativeDeliveryIds');
  });

  it('persists non-blocking summaries and marks them stale from every conversation source', () => {
    const migration = read('server/migrations/238_unify_support_ticket_operations.js');
    const schema = read('server/models/supportTicketSummaries/schema.ts');
    const handoff = read('server/services/agents/pipeline/HandoffService.ts');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS support_ticket_summaries');
    expect(migration).toContain('support_ticket_message_summary_stale_trg');
    expect(migration).toContain('outreach_message_summary_stale_trg');
    expect(migration).toContain('support_chat_message_summary_stale_trg');
    expect(schema).toContain('sourceReferences');
    expect(handoff).toContain('supportTicketWorkspaceService.queueRefresh');
  });

  it('renders guarded pipeline movement plus summary and full conversation views', () => {
    const queue = read('client/src/app/support/tickets/page.tsx');
    const pipeline = read('client/src/app/support/tickets/pipeline/page.tsx');
    const detail = read('client/src/app/support/tickets/[id]/page.tsx');
    expect(queue).toContain('My work');
    expect(queue).toContain('Team queue');
    expect(queue).toContain('Unassigned');
    expect(queue).toContain('Needs human');
    expect(pipeline).toContain('DndContext');
    expect(pipeline).toContain('Move ${ticket.ticketNumber} to stage');
    expect(pipeline).toContain('expectedVersion: ticket.version');
    expect(pipeline).toContain('Claim this ticket before moving it');
    expect(detail).toContain('Ticket ownership');
    expect(detail).toContain('Conversation brief');
    expect(detail).toContain('Full conversation');
    expect(detail).toContain('Reveal restricted content');
    expect(detail).toContain('Claim this ticket before replying or changing its lifecycle');
  });
});
