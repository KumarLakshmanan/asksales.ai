import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(process.cwd(), '..', path), 'utf8');

describe('WhatsApp handoff recovery', () => {
  it('keeps high-value alerts advisory unless a large group requires takeover', () => {
    const agent = read('server/services/agents/HotelSalesAgent.ts');
    expect(agent).toContain('const requiresTakeover = rooms >= LARGE_GROUP_ROOMS');
    expect(agent).toContain('escalated = requiresTakeover;');
    expect(agent).toContain("escalationType = requiresTakeover ? 'sales' : undefined;");
    expect(agent).toContain('handoff: { required: escalated');
    expect(agent).toContain('AND user_id = ${userId}');
    expect(agent).not.toContain('this.doEscalation(');
    expect(agent).not.toContain('supportService.createTicket');
    expect(agent).not.toContain('UPDATE outreach_conversations\n        // eslint-disable-next-line');
  });

  it('keeps breached handoffs human-owned instead of silently resuming AI', () => {
    const service = read('server/services/agents/pipeline/HandoffService.ts');
    expect(service).toContain('breach remains in the human queue; it never silently resumes AI');
    expect(service).not.toContain("resolution = 'sla_expired_ai_resumed'");
    expect(service).not.toContain("SET automation_mode = 'ai_active'");
    expect(service).toContain("status IN ('waiting', 'assigned')");
  });

  it('resumes AI on ticket close while non-close resolutions remain explicit', () => {
    const service = read('server/services/agents/pipeline/HandoffService.ts');
    const modeStage = read('server/services/agents/pipeline/stages/ConversationModeStage.ts');
    const controller = read('server/controllers/supportHandoffController.ts');
    const portal = read('client/src/app/support/tickets/pipeline/page.tsx');
    expect(service).toContain("resolution === 'closed' || options.resumeAi === true");
    expect(service).toContain("outcome: nextMode === 'ai_active' ? 'ai_resumed' : 'human_retained'");
    expect(service).toContain("resumeReason: resolution === 'closed' ? 'ticket_closed'");
    expect(service).toContain('ownershipResolution');
    expect(service).toContain('ai_reply_enabled = TRUE');
    expect(modeStage).toContain("record.outcome === 'human_retained' && record.resumeAi === false");
    expect(modeStage).toContain("systemDirective: 'retained_human_ownership_acknowledgement'");
    expect(modeStage).toContain("systemDirective: 'human_takeover_no_automatic_reply'");
    expect(controller).toContain('const resumeAi = req.body?.resumeAi === true;');
    expect(portal).toContain('Resume AI after resolution');
  });
});
