import { describe, expect, it } from '@jest/globals';
import { agentApproveSchema } from '../middleware/schemas.js';
import { pendingApprovalMatchesRequest } from '../mastra/approvalRequest.js';
import { stripModelTicketOwnershipClaims } from '../services/agents/pipeline/stages/TicketAwareResponseStage.js';
import {
  applyRequestedLeadLimitToBatch,
  extractRequestedLeadLimit,
} from '../mastra/tools/executors/leadRequestConstraints.js';
import {
  deliveryStates,
  leadProviderScenarios,
  regressionTenants,
  supportChannels,
} from './fixtures/crossLayerWorkflowFixtures.js';
import {
  CrossLayerWorkflowHarness,
  createCrossLayerStore,
} from './helpers/crossLayerWorkflowHarness.js';

describe('cross-layer lead lifecycle regression', () => {
  it('preserves the reviewed global cap through provider over-return, dedupe, persistence, and outreach handoff', () => {
    expect(extractRequestedLeadLimit('Find exactly 3 dental clinic leads')).toBe(3);
    const reviewed = applyRequestedLeadLimitToBatch([
      { provider: 'maps', inputs: { maxResults: 50 } },
      { provider: 'linkedin', inputs: { maxResults: 50 } },
    ], 'Find exactly 3 dental clinic leads');
    expect(reviewed).toHaveLength(2);
    expect(reviewed.every(item => item.requestedLeadTotal === 3)).toBe(true);

    const store = createCrossLayerStore();
    const harness = new CrossLayerWorkflowHarness(store);
    const run = harness.executeLeadRun({
      runId: 'lead-run-1',
      tenantId: regressionTenants.alpha.id,
      requestedTotal: 3,
      providers: leadProviderScenarios.overReturningWithDuplicate,
    });

    expect(run).toMatchObject({ status: 'succeeded', leadIds: ['lead-shared', 'lead-alpha', 'lead-beta'] });
    expect(run.leadIds).toHaveLength(3);
    expect(store.leads.size).toBe(3);
    expect(harness.handoffToOutreach({
      tenantId: regressionTenants.alpha.id,
      actionId: 'outreach-action-1',
      reviewedLeadIds: run.leadIds,
    })).toEqual({ replay: false, leadIds: run.leadIds });
    expect(harness.handoffToOutreach({
      tenantId: regressionTenants.alpha.id,
      actionId: 'outreach-action-1',
      reviewedLeadIds: [...run.leadIds].reverse(),
    })).toEqual({ replay: true, leadIds: run.leadIds });
  });

  it.each([
    ['partial failure', leadProviderScenarios.partialFailure, 'partial_success', 1],
    ['all-provider failure', leadProviderScenarios.allFailure, 'failed', 0],
    ['empty success', leadProviderScenarios.emptySuccess, 'succeeded_empty', 0],
  ] as const)('distinguishes %s without timing-dependent retries', (_name, providers, status, total) => {
    const harness = new CrossLayerWorkflowHarness(createCrossLayerStore());
    const run = harness.executeLeadRun({
      runId: `run-${status}`,
      tenantId: regressionTenants.alpha.id,
      requestedTotal: 5,
      providers,
    });
    expect(run.status).toBe(status);
    expect(run.leadIds).toHaveLength(total);
  });

  it('recovers durable progress after a runtime restart and keeps cancelled runs terminal', () => {
    const store = createCrossLayerStore();
    const firstRuntime = new CrossLayerWorkflowHarness(store);
    const cancelled = firstRuntime.executeLeadRun({
      runId: 'cancelled-run',
      tenantId: regressionTenants.alpha.id,
      requestedTotal: 5,
      providers: leadProviderScenarios.overReturningWithDuplicate,
      cancelAfterProvider: 1,
    });
    expect(cancelled).toMatchObject({ status: 'cancelled', providerCursor: 1 });

    const restartedRuntime = new CrossLayerWorkflowHarness(store);
    expect(restartedRuntime.executeLeadRun({
      runId: 'cancelled-run',
      tenantId: regressionTenants.alpha.id,
      requestedTotal: 5,
      providers: leadProviderScenarios.overReturningWithDuplicate,
    })).toEqual(cancelled);
    expect(restartedRuntime.getLeadRun(regressionTenants.alpha.id, 'cancelled-run')).toEqual(cancelled);
  });
});

describe('approval, ticket ownership, delivery, and tenant boundaries', () => {
  it('binds approval resumption to the stable request/tool pair and prevents duplicate effects after reload', () => {
    const request = agentApproveSchema.parse({
      threadId: 81,
      approved: true,
      requestId: 'tool-call-stable-1',
      toolName: 'send_outreach_messages',
      overrides: {},
    });
    const pending = {
      executionId: request.requestId,
      toolName: request.toolName,
      args: { lead_ids: [1, 2] },
      message: 'Approve outreach?',
    };
    expect(pendingApprovalMatchesRequest(pending, request.requestId, request.toolName)).toBe(true);

    const store = createCrossLayerStore();
    const beforeReload = new CrossLayerWorkflowHarness(store);
    expect(beforeReload.handoffToOutreach({ tenantId: regressionTenants.alpha.id, actionId: request.requestId, reviewedLeadIds: ['1', '2'] }).replay).toBe(false);
    const afterReload = new CrossLayerWorkflowHarness(store);
    expect(afterReload.handoffToOutreach({ tenantId: regressionTenants.alpha.id, actionId: request.requestId, reviewedLeadIds: ['1', '2'] })).toEqual({ replay: true, leadIds: ['1', '2'] });
    expect(store.outreachEffects.size).toBe(1);
  });

  it.each(supportChannels)('keeps unrelated facts safe and related transactions human-owned on %s', (channel) => {
    const store = createCrossLayerStore();
    const harness = new CrossLayerWorkflowHarness(store);
    harness.openHumanTicket(regressionTenants.alpha.id, channel, `ticket-${channel}`);

    const factual = harness.handleTicketFollowUp({
      tenantId: regressionTenants.alpha.id,
      ticketId: `ticket-${channel}`,
      channel,
      providerEventId: `event-${channel}-fact`,
      kind: 'unrelated_factual',
    });
    expect(factual).toEqual({ replay: false, disposition: 'read_only_ai_answer', ticketCount: 1 });
    expect(harness.handleTicketFollowUp({
      tenantId: regressionTenants.alpha.id,
      ticketId: `ticket-${channel}`,
      channel,
      providerEventId: `event-${channel}-fact`,
      kind: 'unrelated_factual',
    })).toEqual({ replay: true, disposition: 'read_only_ai_answer', ticketCount: 1 });

    const transactional = harness.handleTicketFollowUp({
      tenantId: regressionTenants.alpha.id,
      ticketId: `ticket-${channel}`,
      channel,
      providerEventId: `event-${channel}-transaction`,
      kind: 'related_transactional',
    });
    expect(transactional.disposition).toBe('human_queue');
    expect(harness.resolveTicket({ tenantId: regressionTenants.alpha.id, ticketId: `ticket-${channel}`, resumeAi: false }).humanOwned).toBe(true);
    expect(harness.resolveTicket({ tenantId: regressionTenants.alpha.id, ticketId: `ticket-${channel}`, resumeAi: true })).toMatchObject({ humanOwned: false, resumeAiExplicit: true });
  });

  it.each(deliveryStates)('persists %s delivery certainty once per provider event', (state) => {
    const store = createCrossLayerStore();
    const harness = new CrossLayerWorkflowHarness(store);
    const first = harness.recordDelivery({
      tenantId: regressionTenants.alpha.id,
      conversationId: 901,
      channel: 'whatsapp',
      providerEventId: `delivery-${state}`,
      state,
    });
    const replay = harness.recordDelivery({
      tenantId: regressionTenants.alpha.id,
      conversationId: 901,
      channel: 'whatsapp',
      providerEventId: `delivery-${state}`,
      state: state === 'failed' ? 'sent' : state,
    });
    expect(replay).toEqual(first);
    expect(replay.mutationCount).toBe(1);
  });

  it('isolates identical run, ticket, event, action, and delivery IDs by tenant', () => {
    const store = createCrossLayerStore();
    const harness = new CrossLayerWorkflowHarness(store);
    for (const tenant of Object.values(regressionTenants)) {
      harness.executeLeadRun({ runId: 'same-run', tenantId: tenant.id, requestedTotal: 1, providers: leadProviderScenarios.emptySuccess });
      harness.openHumanTicket(tenant.id, 'web', 'same-ticket');
      harness.handleTicketFollowUp({ tenantId: tenant.id, ticketId: 'same-ticket', channel: 'web', providerEventId: 'same-event', kind: 'related_transactional' });
      harness.handoffToOutreach({ tenantId: tenant.id, actionId: 'same-action', reviewedLeadIds: [`lead-${tenant.id}`] });
      harness.recordDelivery({ tenantId: tenant.id, conversationId: 1, channel: 'web', providerEventId: 'same-delivery', state: 'accepted' });
    }
    expect(store.runs.size).toBe(2);
    expect(store.tickets.size).toBe(2);
    expect(store.inboundEvents.size).toBe(2);
    expect(store.outreachEffects.size).toBe(2);
    expect(store.deliveries.size).toBe(2);
  });

  it('removes model-authored ticket ownership claims from safe factual replies', () => {
    expect(stripModelTicketOwnershipClaims('Our hours are 9–5. A human agent will take over while you wait.')).toBe('Our hours are 9–5.');
  });
});
