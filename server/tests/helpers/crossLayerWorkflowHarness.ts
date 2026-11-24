import { createDeliveryDecisionKey } from '../../services/agents/orchestration/DeliveryOutboxService.js';
import {
  partitionProviderDatasetResults,
} from '../../services/workflow/providerDatasetResults.js';
import type {
  DeliveryStateFixture,
  LeadFixture,
  LeadProviderFixture,
  SupportChannelFixture,
} from '../fixtures/crossLayerWorkflowFixtures.js';

type RunStatus = 'running' | 'succeeded' | 'partial_success' | 'succeeded_empty' | 'failed' | 'cancelled';

type LeadRun = {
  runId: string;
  tenantId: number;
  requestedTotal: number;
  providerCursor: number;
  failedProviders: string[];
  successfulProviders: string[];
  leadIds: string[];
  status: RunStatus;
};

type TicketState = {
  id: string;
  tenantId: number;
  channel: SupportChannelFixture;
  humanOwned: boolean;
  resumeAiExplicit: boolean;
};

type DeliveryRecord = {
  key: string;
  tenantId: number;
  state: DeliveryStateFixture;
  mutationCount: number;
};

export type CrossLayerStore = {
  runs: Map<string, LeadRun>;
  leads: Map<string, LeadFixture & { tenantId: number }>;
  outreachEffects: Map<string, { tenantId: number; leadIds: string[] }>;
  tickets: Map<string, TicketState>;
  inboundEvents: Set<string>;
  deliveries: Map<string, DeliveryRecord>;
};

export function createCrossLayerStore(): CrossLayerStore {
  return {
    runs: new Map(),
    leads: new Map(),
    outreachEffects: new Map(),
    tickets: new Map(),
    inboundEvents: new Set(),
    deliveries: new Map(),
  };
}

function tenantKey(tenantId: number, value: string): string {
  return `${tenantId}:${value}`;
}

function leadIdentity(lead: LeadFixture): string {
  return (lead.email || lead.profileUrl || lead.externalId).trim().toLowerCase();
}

export class CrossLayerWorkflowHarness {
  constructor(private readonly store: CrossLayerStore) {}

  executeLeadRun(input: {
    runId: string;
    tenantId: number;
    requestedTotal: number;
    providers: LeadProviderFixture[];
    cancelAfterProvider?: number;
  }): LeadRun {
    const key = tenantKey(input.tenantId, input.runId);
    const existing = this.store.runs.get(key);
    if (existing && existing.status !== 'running') return structuredClone(existing);

    const run: LeadRun = existing || {
      runId: input.runId,
      tenantId: input.tenantId,
      requestedTotal: input.requestedTotal,
      providerCursor: 0,
      failedProviders: [],
      successfulProviders: [],
      leadIds: [],
      status: 'running',
    };
    this.store.runs.set(key, run);

    for (let index = run.providerCursor; index < input.providers.length; index += 1) {
      if (input.cancelAfterProvider === index) {
        run.status = 'cancelled';
        return structuredClone(run);
      }

      const provider = input.providers[index];
      run.providerCursor = index + 1;
      if (provider.outcome === 'failure') {
        run.failedProviders.push(provider.name);
        continue;
      }

      run.successfulProviders.push(provider.name);
      const { validResults } = partitionProviderDatasetResults(provider.leads || []);
      for (const lead of validResults) {
        if (run.leadIds.length >= input.requestedTotal) break;
        const identity = tenantKey(input.tenantId, leadIdentity(lead));
        if (this.store.leads.has(identity)) continue;
        this.store.leads.set(identity, { ...lead, tenantId: input.tenantId });
        run.leadIds.push(lead.externalId);
      }
    }

    if (run.failedProviders.length === input.providers.length) run.status = 'failed';
    else if (run.failedProviders.length > 0) run.status = 'partial_success';
    else if (run.leadIds.length === 0) run.status = 'succeeded_empty';
    else run.status = 'succeeded';
    return structuredClone(run);
  }

  handoffToOutreach(input: {
    tenantId: number;
    actionId: string;
    reviewedLeadIds: string[];
  }): { replay: boolean; leadIds: string[] } {
    const key = tenantKey(input.tenantId, input.actionId);
    const existing = this.store.outreachEffects.get(key);
    if (existing) return { replay: true, leadIds: [...existing.leadIds] };
    const exactIds = [...new Set(input.reviewedLeadIds)];
    this.store.outreachEffects.set(key, { tenantId: input.tenantId, leadIds: exactIds });
    return { replay: false, leadIds: exactIds };
  }

  openHumanTicket(tenantId: number, channel: SupportChannelFixture, ticketId: string): TicketState {
    const ticket: TicketState = { id: ticketId, tenantId, channel, humanOwned: true, resumeAiExplicit: false };
    this.store.tickets.set(tenantKey(tenantId, ticketId), ticket);
    return structuredClone(ticket);
  }

  handleTicketFollowUp(input: {
    tenantId: number;
    ticketId: string;
    channel: SupportChannelFixture;
    providerEventId: string;
    kind: 'unrelated_factual' | 'related_transactional';
  }): { replay: boolean; disposition: 'read_only_ai_answer' | 'human_queue'; ticketCount: number } {
    const eventKey = tenantKey(input.tenantId, `${input.channel}:${input.providerEventId}`);
    const ticket = this.store.tickets.get(tenantKey(input.tenantId, input.ticketId));
    if (!ticket || ticket.channel !== input.channel) throw new Error('Tenant-owned ticket not found for channel.');
    const replay = this.store.inboundEvents.has(eventKey);
    this.store.inboundEvents.add(eventKey);
    return {
      replay,
      disposition: input.kind === 'unrelated_factual' ? 'read_only_ai_answer' : 'human_queue',
      ticketCount: [...this.store.tickets.values()].filter(item => item.tenantId === input.tenantId).length,
    };
  }

  resolveTicket(input: { tenantId: number; ticketId: string; resumeAi: boolean }): TicketState {
    const key = tenantKey(input.tenantId, input.ticketId);
    const ticket = this.store.tickets.get(key);
    if (!ticket) throw new Error('Tenant-owned ticket not found.');
    ticket.resumeAiExplicit = input.resumeAi;
    ticket.humanOwned = !input.resumeAi;
    return structuredClone(ticket);
  }

  recordDelivery(input: {
    tenantId: number;
    conversationId: number;
    channel: SupportChannelFixture;
    providerEventId: string;
    state: DeliveryStateFixture;
  }): DeliveryRecord {
    const key = createDeliveryDecisionKey({
      userId: input.tenantId,
      conversationId: input.conversationId,
      channel: input.channel,
      inboundProviderMessageId: input.providerEventId,
    });
    const existing = this.store.deliveries.get(key);
    if (existing) return structuredClone(existing);
    const record = { key, tenantId: input.tenantId, state: input.state, mutationCount: 1 };
    this.store.deliveries.set(key, record);
    return structuredClone(record);
  }

  getLeadRun(tenantId: number, runId: string): LeadRun | undefined {
    const run = this.store.runs.get(tenantKey(tenantId, runId));
    return run ? structuredClone(run) : undefined;
  }
}
