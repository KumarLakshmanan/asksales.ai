import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), 'utf8');

describe('WhatsApp handoff recovery and support presence contracts', () => {
  it('keeps authenticated support-portal responses private and fresh', () => {
    const routes = read('routes/supportMember.routes.ts');
    expect(routes).toContain("res.setHeader('Cache-Control', 'private, no-store, max-age=0')");
    expect(routes).toContain("res.setHeader('Pragma', 'no-cache')");
  });

  it('returns a complete writable availability contract for members with legacy empty quiet hours', () => {
    const controller = read('controllers/supportNotificationPreferencesController.ts');
    expect(controller).toContain('data:notificationAvailability(member)');
    expect(controller).toContain("quietHours?.enabled === 'boolean'");
    expect(controller).toContain("quietHours.start : '22:00'");
    expect(controller).toContain("quietHours.end : '08:00'");
  });

  it('records moderation availability separately and preserves governed provider order', () => {
    const source = read('services/agents/orchestration/ContentModerationService.ts');
    expect(source).toContain("status: 'safe' | 'flagged' | 'unavailable'");
    expect(source).toContain("getAllActiveAdminCredentials('openrouter')");
    expect(source.indexOf('for (const openAiApiKey')).toBeLessThan(source.indexOf('for (const vertexCredential'));
    expect(source.indexOf('for (const openRouterCredential')).toBeLessThan(source.indexOf('for (const vertexCredential'));
    expect(source.indexOf('for (const vertexCredential')).toBeLessThan(source.indexOf('for (const geminiCredential'));
    expect(source).toContain("source: 'unavailable'");
    expect(source).toContain("model: 'omni-moderation-latest'");
  });

  it('requires a current ticket-backed queue row before human ownership suppresses AI', () => {
    const source = read('services/agents/pipeline/stages/ConversationModeStage.ts');
    expect(source).toContain('JOIN support_tickets t');
    expect(source).toContain("t.status NOT IN ('resolved', 'closed')");
    expect(source).toContain('Ignoring stale human ownership without an active ticket-backed handoff');
    expect(source).not.toContain('This conversation remains with the human support team');
  });

  it('uses immutable, five-minute presence intervals and reconciles only unclaimed outage handoffs', () => {
    const migration = read('migrations/226_add_support_member_presence.js');
    expect(migration).toContain('support_member_presence_sessions');
    expect(migration).toContain('support_presence_one_open_session_uq');
    expect(migration).toContain('WHERE ended_at IS NULL');
    expect(migration).toContain("resolution = 'moderation_unavailable_reconciled'");
    expect(migration).toContain('h.accepted_at IS NULL');
    expect(migration).toContain("stm.direction = 'outbound'");
    expect(migration).not.toMatch(/UPDATE\s+outreach_conversations/i);
  });

  it('prevents concurrent provider retries from creating duplicate handoff tickets', () => {
    const migration = read('migrations/227_make_handoff_ticket_creation_idempotent.js');
    const handoff = read('services/agents/pipeline/HandoffService.ts');
    const tickets = read('services/SupportService.ts');
    expect(migration).toContain('support_ticket_one_open_handoff_key_uq');
    expect(migration).toContain('ON support_tickets(user_id, handoff_key)');
    expect(handoff).toContain('handoffKey: `${channel}:${conversationId}`');
    expect(tickets).toContain('.onConflictDoNothing().returning()');
    expect(tickets).toContain('Support ticket could not be created or reconciled.');
  });

  it('assigns only enabled teams and members with a fresh heartbeat and counts unreplied work', () => {
    const source = read('services/SupportPresenceService.ts');
    expect(source).toContain('SUPPORT_PRESENCE_IDLE_MINUTES = 5');
    expect(source).toContain('ps.last_seen_at > NOW()');
    expect(source).toContain('tm.is_active IS TRUE AND st.is_active IS TRUE');
    expect(source).toContain("t.status IN ('open', 'in_progress')");
    expect(source).toContain("member_reply.direction = 'outbound'");
    // Owner replies intentionally have no member_id and must still clear the
    // unreplied workload for the shared queue.
    expect(source).not.toContain('member_reply.member_id IS NOT NULL');
    expect(source).toContain("customer_message.direction = 'inbound'");
    expect(source).toContain('ORDER BY unreplied_count ASC, is_on_call DESC');
    expect(source).toContain('(workload + 1) * settings.handlingMinutesPerTicket');
  });

  it('keeps employment enablement separate from portal heartbeat activity', () => {
    const auth = read('../client/src/contexts/SupportAuthContext.tsx');
    const teamPage = read('../client/src/app/dashboard/(main)/support/teams/[id]/page.tsx');
    const activityPage = read('../client/src/app/dashboard/(main)/support/teams/[id]/members/[memberId]/activity/page.tsx');
    expect(auth).toContain('/api/support-portal/presence/heartbeat');
    expect(auth).toContain('60_000');
    expect(teamPage).toContain('Enabled');
    expect(teamPage).toContain('Away');
    expect(activityPage).toContain('activity');
    expect(activityPage).toContain('90 days');
    expect(activityPage).toContain('365 days');
    expect(activityPage).toContain('Awaiting reply');
  });

  it('uses the same presence-aware response estimate for manual ticket creation', () => {
    const service = read('services/SupportService.ts');
    const controller = read('controllers/supportPresenceController.ts');
    const routes = read('routes/support.routes.ts');
    const dashboard = read('../client/src/app/dashboard/(main)/support/page.tsx');
    const createDialog = read('../client/src/components/support/CreateSupportTicketDialog.tsx');
    expect(service).toContain("supportPresenceService.estimateRouting(userId, 'web', resolvedTeamId, database)");
    expect(service).toContain('effectiveSlaDeadline');
    expect(service).toContain('metadata: responseEstimate ? { responseEstimate } : {}');
    expect(controller).toContain('getRoutingEstimate');
    expect(routes).toContain("'/teams/routing-estimate'");
    expect(dashboard).toContain('<CreateSupportTicketDialog');
    expect(createDialog).toContain('/api/support/teams/routing-estimate?channel=web&teamId=${createForm.teamId}');
    expect(createDialog).toContain('No active responder.');
    expect(createDialog).toContain('routingEstimate.estimatedMinutes');
  });

  it('splits clicked-day activity intervals in the member timezone', () => {
    const source = read('services/supportPresenceTime.ts');
    expect(source).toContain('nextLocalDayBoundary');
    expect(source).toContain('splitPresenceIntervalsByLocalDay');
    expect(source).toContain('clippedToDay');
    expect(source).toContain('mergedDurationMs');
  });

  it('closes stale intervals through the worker even when nobody opens the dashboard', () => {
    const cron = read('services/cronService.ts');
    const worker = read('workers/index.ts');
    expect(cron).toContain('cron-support-presence-maintenance');
    expect(worker).toContain("case 'cron-support-presence-maintenance'");
    expect(worker).toContain('supportPresenceService.closeStaleSessions()');
  });
});
