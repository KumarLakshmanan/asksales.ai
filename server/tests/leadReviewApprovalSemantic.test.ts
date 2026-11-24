import { describe, expect, it } from '@jest/globals';
import { isReviewedLeadApprovalTurn } from '../mastra/agents/leadAgent.js';
import { prepareLeadReviewPipeline } from '../mastra/orchestrator.js';
import { normalizeRouterDecision } from '../mastra/unifiedRouter.js';
import { routerOutputSchema } from '../mastra/routerSchema.js';

const decision = (overrides: Record<string, unknown>) => routerOutputSchema.parse({
  intent: 'task', action: 'continue', hiredAgents: [], mode: 'none', isAffirmative: true, isDomainMatch: true,
  navigationTarget: null, response: '', nextAgent: null, suggestAgents: false, recommendedAgents: [],
  ...overrides,
});

describe('language-independent reviewed-lead approval', () => {
  it('accepts a non-English approval only from the validated router reading', () => {
    const tamil = 'மதிப்பாய்வு செய்த லீட்களை நான் அங்கீகரிக்கிறேன்.';
    expect(isReviewedLeadApprovalTurn(tamil, undefined)).toBe(false);
    expect(isReviewedLeadApprovalTurn(tamil, decision({ leadReviewApproval: false }))).toBe(false);
    expect(isReviewedLeadApprovalTurn(tamil, decision({ leadReviewApproval: true }))).toBe(true);
  });

  it('still accepts the exact phrase the approval button sends', () => {
    expect(isReviewedLeadApprovalTurn('I approve the reviewed leads.', undefined)).toBe(true);
  });

  it('never treats a question, cancellation or clarification as approval', () => {
    for (const action of ['question', 'cancel', 'clarify']) {
      expect(isReviewedLeadApprovalTurn('ok', decision({ leadReviewApproval: true, action }))).toBe(false);
      expect(normalizeRouterDecision(decision({ leadReviewApproval: true, action })).leadReviewApproval).toBe(false);
    }
    expect(isReviewedLeadApprovalTurn('ok', decision({ leadReviewApproval: true, needsClarification: true }))).toBe(false);
    expect(normalizeRouterDecision(decision({ leadReviewApproval: true })).leadReviewApproval).toBe(true);
  });

  it('defaults to not approved when the router omits the field', () => {
    expect(decision({}).leadReviewApproval).toBe(false);
  });

  it('releases the handoff gate only for an executed search with saved leads', () => {
    const approving = decision({ leadReviewApproval: true });
    const withLeads = { leadWorkflowExecuted: true, leadReviewApproved: false, selectedLeadIds: [101], agentPipeline: [], intentAnalysis: approving } as never as Parameters<typeof prepareLeadReviewPipeline>[0];
    prepareLeadReviewPipeline(withLeads, 'Sí, apruebo los leads revisados.');
    expect(withLeads.leadReviewApproved).toBe(true);

    const noLeads = { leadWorkflowExecuted: true, leadReviewApproved: false, selectedLeadIds: [], agentPipeline: [], intentAnalysis: approving } as never as Parameters<typeof prepareLeadReviewPipeline>[0];
    prepareLeadReviewPipeline(noLeads, 'Sí, apruebo los leads revisados.');
    expect(noLeads.leadReviewApproved).toBe(false);

    const notExecuted = { leadWorkflowExecuted: false, leadReviewApproved: false, selectedLeadIds: [101], agentPipeline: [], intentAnalysis: approving } as never as Parameters<typeof prepareLeadReviewPipeline>[0];
    prepareLeadReviewPipeline(notExecuted, 'Sí, apruebo los leads revisados.');
    expect(notExecuted.leadReviewApproved).toBe(false);
  });
});
