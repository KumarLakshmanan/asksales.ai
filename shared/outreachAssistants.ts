/** Public, non-secret contract for assistant management and simulator traces. */
export const ASSISTANT_CHANNELS = [
  "whatsapp",
  "instagram",
  "facebook",
  "email",
  "web",
] as const;
export type AssistantChannel = (typeof ASSISTANT_CHANNELS)[number];
export type AssistantSurface = "private" | "public_comment";
export type AssistantState = "draft" | "live" | "paused" | "needs_attention";
export interface AssistantModel {
  provider: string;
  model: string;
}
export interface AssistantBindingInput {
  channel: AssistantChannel;
  surface: AssistantSurface;
  accountId: string;
}
export interface AssistantSelection {
  mode: "unconfigured" | "none" | "selected";
  ids: number[];
}
export interface AssistantPlaybookSelection {
  mode: AssistantSelection["mode"];
  assignments: {
    playbookId: number;
    channel: AssistantChannel;
    surface: AssistantSurface;
    intent: string | null;
    priority: number;
  }[];
}
export interface AssistantFollowUps {
  mode: AssistantSelection["mode"];
  sequences: {
    channel: Exclude<AssistantChannel, "web">;
    /** Omitted messageMode preserves existing template-based configurations. */
    steps: { delayMinutes: number; templateId: number; messageMode?: 'template' | 'ai' }[];
  }[];
}
/** Email has no WhatsApp-style reply window; both use the same bounded check-in generator. */
export function assistantAiFollowUpAvailable(channel: AssistantChannel, delayMinutes: number): boolean {
  return Number.isInteger(delayMinutes) && delayMinutes >= 1 && delayMinutes <= 43200
    && (channel === 'email' || (channel === 'whatsapp' && delayMinutes < 1440));
}
/** Draft-save validation; optional resource decisions may still be unfinished. */
export function assistantFollowUpSaveIssues(value: AssistantFollowUps): string[] {
  const issues: string[] = [];
  if (value.mode === 'selected' && !value.sequences.length) issues.push('Add a follow-up channel or choose No automatic follow-ups.');
  for (const sequence of value.sequences) {
    if (!sequence.steps.length || sequence.steps.length > 3) issues.push(`${sequence.channel}: add one to three follow-up messages.`);
    sequence.steps.forEach((step, index) => {
      const label = `${sequence.channel} message ${index + 1}`;
      if (!Number.isInteger(step.delayMinutes) || step.delayMinutes < 1 || step.delayMinutes > 43200) issues.push(`${label}: enter a whole-minute delay between 1 and 43200.`);
      if (step.messageMode === 'ai') {
        if (!assistantAiFollowUpAvailable(sequence.channel, step.delayMinutes) || step.templateId !== 0) issues.push(`${label}: AI replies require email, or WhatsApp with a delay under 24 hours, and no template selection.`);
      } else if (!Number.isSafeInteger(step.templateId) || step.templateId <= 0) issues.push(`${label}: choose an approved template before saving.`);
    });
  }
  return issues;
}
export interface AssistantAvailability {
  enabled: boolean;
  timezone: string;
  /** ISO weekday: 1 = Monday, 7 = Sunday. Ranges cannot cross midnight. */
  weekly: { day: number; ranges: { start: string; end: string }[] }[];
  awayMessage: string | null;
}
export interface AssistantDraft {
  name: string;
  description: string;
  agentType: string;
  bindings: AssistantBindingInput[];
  instructions: string;
  demonstrations: { customer: string; assistant: string }[];
  replyModel: AssistantModel | null;
  fallbackModels: AssistantModel[];
  response: { maxReplyTokens: number; temperature?: number; topP?: number };
  knowledge: AssistantSelection;
  playbooks: AssistantPlaybookSelection;
  followUps: AssistantFollowUps;
  documents: AssistantSelection;
  galleries: AssistantSelection;
  tools: {
    mode: AssistantSelection["mode"];
    names: string[];
    approvalRequired: string[];
  };
  privacy: {
    /** Baseline redaction, encrypted vault and approvals are NOT configurable. */
    permittedCollectionFields: string[];
    minimumConfidence: number;
    uncertaintyMessage: string;
    handoff: "offer" | "customer_request";
  };
  policies: Record<string, unknown>;
  availability: AssistantAvailability;
}
export interface AssistantAccount extends AssistantBindingInput {
  label: string;
  connected: boolean;
  assignedAssistantId?: string | null;
}
export interface AssistantResource {
  id: number;
  name: string;
  channels: string[];
  agentType?: string;
  intent?: string;
  /** Published playbook routing copied into a new assistant assignment. */
  defaultAssignments?: { intent: string | null; priority: number }[];
  collectionFields?: string[];
  variables?: string[];
  preview?: string;
  status?: string;
  availabilityReason?: string;
  sourceVersion?: number;
}
export interface AssistantCatalog {
  modelAvailabilityNotice?: string;
  runtimeEnabled: boolean;
  presets: {
    agentType: string;
    name: string;
    description: string;
    instructions: string;
    tools: string[];
    policies: Record<string, unknown>;
  }[];
  accounts: AssistantAccount[];
  models: (AssistantModel & {
    label: string;
    description?: string;
    controls: ("temperature" | "topP")[];
  })[];
  knowledge: AssistantResource[];
  playbooks: AssistantResource[];
  templates: AssistantResource[];
  documents: AssistantResource[];
  galleries: AssistantResource[];
  tools: { name: string; label: string; approvalRequired: boolean }[];
  unavailableResources?: (AssistantResource & { category: 'templates' | 'knowledge' | 'documents' | 'galleries' })[];
  permissions: { canManage: boolean; description: string };
}
export interface AssistantReadiness {
  ready: boolean;
  checks: { key: string; label: string; ok: boolean; detail: string }[];
}
export interface OutreachAssistant {
  id: string;
  businessProfileId: number;
  state: AssistantState;
  draft: AssistantDraft;
  draftVersion: number;
  publishedRevision: number | null;
  published: AssistantDraft | null;
  enabledBindings?: AssistantBindingInput[];
  readiness: AssistantReadiness;
  updatedAt: string;
}
export interface AssistantProvenance {
  assistantId: string;
  revision: number;
  bindingId: number;
  bindingVersion: number;
  businessProfileId: number;
  accountId: string;
  channel: AssistantChannel;
  surface: AssistantSurface;
}
export function emptyAssistantDraft(): AssistantDraft {
  const unset = (): AssistantSelection => ({ mode: "unconfigured", ids: [] });
  return {
    name: "",
    description: "",
    agentType: "",
    bindings: [],
    instructions: "",
    demonstrations: [],
    replyModel: null,
    fallbackModels: [],
    response: { maxReplyTokens: 600 },
    knowledge: unset(),
    playbooks: { mode: "unconfigured", assignments: [] },
    followUps: { mode: "unconfigured", sequences: [] },
    documents: unset(),
    galleries: unset(),
    tools: { mode: "unconfigured", names: [], approvalRequired: [] },
    privacy: {
      permittedCollectionFields: [],
      minimumConfidence: 0.7,
      uncertaintyMessage:
        "I’m not sure about this. Would you like me to connect you with support?",
      handoff: "offer",
    },
    policies: {},
    availability: {
      enabled: false,
      timezone: "UTC",
      weekly: [],
      awayMessage: null,
    },
  };
}
export function assistantBindingKey(binding: AssistantBindingInput): string {
  return `${binding.channel}:${binding.surface}:${binding.accountId}`;
}

/** A stable key for an assistant model (provider + model). */
export const assistantModelKey = (model: AssistantModel) => JSON.stringify([model.provider, model.model]);
