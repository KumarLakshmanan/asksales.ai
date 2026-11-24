import { businessProfileColumn } from "../businessProfileColumn.js";
import type { SupportCapabilityName } from '../../../shared/supportCapabilities.js';
import {
  pgTable,
  primaryKey,
  serial,
  bigserial,
  bigint,
  integer,
  real,
  text,
  varchar,
  timestamp,
  boolean,
  jsonb,
  index,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { usersTable } from '../users/schema.js';
import { outreachMessagesTable } from '../outreachConversations/schema.js';
import { supportTeamsTable } from '../supportTeams/schema.js';
import { teamMembersTable } from '../teamMembers/schema.js';
import { adminsTable } from '../admins/schema.js';
import { toolApprovalsTable } from '../toolApprovals/schema.js';

export type PiiType =
  | 'address'
  | 'email'
  | 'phone'
  | 'payment_card'
  | 'ssn'
  | 'government_id'
  | 'ip_address'
  | 'credential'
  | 'otp'
  | 'name';

export type PlaybookNodeType =
  | 'trigger'
  | 'message'
  | 'question'
  | 'condition'
  | 'action'
  | 'escalation'
  | 'collect'
  | 'knowledge'
  | 'media'
  | 'capability'
  | 'handoff'
  | 'complete';

export type PlaybookFieldType =
  | 'text'
  | 'integer'
  | 'money'
  | 'date'
  | 'datetime'
  | 'email'
  | 'phone'
  | 'boolean'
  | 'single_select'
  | 'multi_select';

export interface PlaybookFieldOption {
  value: string;
  label: string;
  /** Optional provider-safe label for native buttons and quick replies (max 20 characters). */
  shortLabel?: string;
  aliases?: string[];
}

export interface PlaybookFieldDefinition {
  key: string;
  type: PlaybookFieldType;
  required: boolean;
  pii: 'none' | 'contact' | 'sensitive';
  prompt: string;
  validation?: {
    min?: number;
    max?: number;
    minLength?: number;
    maxLength?: number;
    entityKeys?: string[];
    /** Optional full-match rule for free-form text captured from a prompt. */
    pattern?: string;
    /**
     * Owner-approved literal replies that may be collected from a compound
     * answer even when the NLU provider does not return a keyed entity.
     */
    literalValues?: Array<{ value: string; aliases?: string[] }>;
  };
  options?: PlaybookFieldOption[];
  profileBinding?: PlaybookProfileBinding;
}

export interface PlaybookProfileBinding {
  attribute: 'fullName' | 'firstName' | 'lastName' | 'email' | 'phone' | 'company';
  read: boolean;
  writeBack: 'fill_missing_or_verify_correction' | 'never';
  minimumTrust: 'provider' | 'customer_verified' | 'owner_verified';
}

export interface PlaybookPresentationPolicy {
  mode: 'fixed' | 'governed_hybrid';
  tone?: string;
  guidance?: string;
  optionStrategy: 'all' | 'relevant_subset';
  allowReordering: boolean;
  avoidRecentPhrasings: boolean;
  deterministicFallback: string;
}

export interface SupportChoiceOption {
  /** Opaque, deterministic provider payload. It contains no field value or PII. */
  id: string;
  value: string;
  label: string;
  shortLabel: string;
}

export interface SupportChoiceManifest {
  schemaVersion: 1;
  fieldKey: string;
  prompt: string;
  fallbackText: string;
  allowFreeText: true;
  options: SupportChoiceOption[];
}

export interface PlaybookFieldState {
  value?: unknown;
  status: 'missing' | 'collected' | 'verified' | 'invalid' | 'correction_pending';
  source: 'customer' | 'tool' | 'owner' | 'crm';
  vaultRef?: number;
  trust?: 'provider' | 'customer_verified' | 'owner_verified';
  /** Consent applies to the booking name only, never to checkout or CRM changes. */
  bookingNameConfirmed?: boolean;
  bookingNameDeclined?: boolean;
}

export interface PlaybookRunStateV2 extends Record<string, unknown> {
  graphVersion: number;
  fields: Record<string, PlaybookFieldState>;
  pendingConfirmation?: { summaryFingerprint: string; confirmed: boolean };
  suspendedQuestion?: { nodeId: string; reason: 'customer_interruption' };
}

export type PlaybookValueBinding =
  | { source: 'field'; key: string }
  | { source: 'sum'; keys: string[] }
  | { source: 'coalesce'; keys: string[] }
  | { source: 'constant'; value: unknown }
  | { source: 'context'; key: 'intent' | 'channel' | 'conversationId' | 'contactAvailable' };

export type PlaybookCapabilityName = SupportCapabilityName;

export interface PlaybookNode {
  id: string;
  type: PlaybookNodeType;
  data?: Record<string, unknown>;
  presentation?: PlaybookPresentationPolicy;
  /** Editor-only layout metadata; ignored by runtime traversal. */
  position?: { x: number; y: number };
}

export interface PlaybookEdge {
  id?: string;
  source: string;
  target: string;
  condition?: {
    operator:
      | 'always'
      | 'contains'
      | 'not_contains'
      | 'equals'
      | 'matches_intent'
      | 'field_present'
      | 'field_missing'
      | 'field_equals'
      | 'field_in'
      | 'all_required_fields_present'
      | 'confirmation_is'
      | 'capability_status_is'
      | 'grounding_is'
      | 'delivery_is';
    value?: string;
    field?: string;
    values?: string[];
    capability?: PlaybookCapabilityName;
  };
  /** Lower values are evaluated first; unconditional fallback must be last. */
  priority?: number;
}

export interface PlaybookControlProfile {
  privacy: 'enforced';
  piiRedaction: 'enforced';
  safety: 'enforced';
  humanHandoff: 'enabled';
  toolApproval: 'required';
}

export interface PlaybookGraphMetadata {
  templateKey?: string;
  templateVersion?: number;
  systemDefault?: boolean;
  agentType?: string;
  controls?: PlaybookControlProfile;
  presentationDefaults?: PlaybookPresentationPolicy;
}

export interface PlaybookGraph {
  /** Omitted/1 is the legacy instruction graph. Version 2 adds typed fields and capabilities. */
  schemaVersion?: 1 | 2;
  entryNodeId: string;
  fields?: PlaybookFieldDefinition[];
  nodes: PlaybookNode[];
  edges: PlaybookEdge[];
  variants?: Array<{ id: string; weight: number; entryNodeId?: string }>;
  /** Runtime-neutral provenance and control status shown in the playbook UI. */
  metadata?: PlaybookGraphMetadata;
}

export interface PlaybookTemplateAssignment {
  channel: string | null;
  intent: string | null;
  agentType: string;
  priority: number;
  trafficPercent: number;
  enabled?: boolean;
}

/** Platform-wide source templates edited by super admins. */
export const supportPlaybookTemplatesTable = pgTable('support_playbook_templates', {
  id: serial('id').primaryKey(),
  templateKey: varchar('template_key', { length: 120 }).notNull().unique(),
  name: varchar('name', { length: 160 }).notNull(),
  description: text('description'),
  agentType: varchar('agent_type', { length: 50 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('published'),
  graph: jsonb('graph').$type<PlaybookGraph>().notNull(),
  assignments: jsonb('assignments').$type<PlaybookTemplateAssignment[]>().notNull().default([]),
  version: integer('version').notNull().default(1),
  createdByAdmin: integer('created_by_admin').references(() => adminsTable.id, { onDelete: 'set null' }),
  updatedByAdmin: integer('updated_by_admin').references(() => adminsTable.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  statusAgentIdx: index('idx_support_playbook_templates_status_agent').on(table.status, table.agentType),
}));

export const supportPrivacyVaultTable = pgTable('support_privacy_vault', {
  businessProfileId: businessProfileColumn(),
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  conversationId: integer('conversation_id'),
  messageId: integer('message_id').references(() => outreachMessagesTable.id, { onDelete: 'set null' }),
  channel: varchar('channel', { length: 20 }).notNull(),
  providerMessageId: varchar('provider_message_id', { length: 255 }),
  entityType: varchar('entity_type', { length: 40 }),
  entityId: bigint('entity_id', { mode: 'number' }),
  ciphertext: text('ciphertext').notNull(),
  iv: varchar('iv', { length: 64 }).notNull(),
  authTag: varchar('auth_tag', { length: 64 }).notNull(),
  keyVersion: integer('key_version').notNull().default(1),
  piiTypes: jsonb('pii_types').$type<PiiType[]>().notNull().default([]),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  userExpiryIdx: index('idx_support_privacy_vault_user_expiry').on(table.userId, table.expiresAt),
  conversationIdx: index('idx_support_privacy_vault_conversation').on(table.userId, table.conversationId),
  providerMessageUq: uniqueIndex('support_privacy_vault_provider_message_uq')
    .on(table.businessProfileId, table.userId, table.channel, table.providerMessageId),
  entityIdx: index('idx_support_privacy_vault_entity').on(table.userId, table.entityType, table.entityId),
}));

export const supportPrivacyAccessLogsTable = pgTable('support_privacy_access_logs', {
  businessProfileId: businessProfileColumn(),
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  vaultId: bigint('vault_id', { mode: 'number' }).references(() => supportPrivacyVaultTable.id, { onDelete: 'set null' }),
  handoffId: integer('handoff_id'),
  messageId: integer('message_id'),
  memberId: integer('member_id'),
  action: varchar('action', { length: 40 }).notNull().default('reveal'),
  reason: varchar('reason', { length: 240 }),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  ownerCreatedIdx: index('idx_support_privacy_access_owner_created').on(table.userId, table.createdAt),
  vaultIdx: index('idx_support_privacy_access_vault').on(table.vaultId),
}));

export const supportCannedResponsesTable = pgTable('support_canned_responses', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  teamId: integer('team_id').references(() => supportTeamsTable.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 120 }).notNull(),
  content: text('content').notNull(),
  channel: varchar('channel', { length: 20 }),
  tags: jsonb('tags').$type<string[]>().notNull().default([]),
  isActive: boolean('is_active').notNull().default(true),
  createdByMemberId: integer('created_by_member_id').references(() => teamMembersTable.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  ownerTeamIdx: index('idx_support_canned_owner_team').on(table.userId, table.teamId, table.isActive),
}));

export const supportAdminAuditLogsTable = pgTable('support_admin_audit_logs', {
  businessProfileId: businessProfileColumn(),
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  actorType: varchar('actor_type', { length: 30 }).notNull(),
  actorId: integer('actor_id'),
  action: varchar('action', { length: 80 }).notNull(),
  entityType: varchar('entity_type', { length: 80 }).notNull(),
  entityId: varchar('entity_id', { length: 120 }),
  beforeState: jsonb('before_state').$type<Record<string, unknown> | null>(),
  afterState: jsonb('after_state').$type<Record<string, unknown> | null>(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  ownerCreatedIdx: index('idx_support_admin_audit_owner_created').on(table.userId, table.createdAt),
  entityIdx: index('idx_support_admin_audit_entity').on(table.userId, table.entityType, table.entityId),
}));

export const supportPlaybooksTable = pgTable('support_playbooks', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  /** Immutable owner; only the active agent's playbooks are exposed or runnable. */
  agentType: varchar('agent_type', { length: 50 }).notNull(),
  name: varchar('name', { length: 160 }).notNull(),
  description: text('description'),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  enabled: boolean('enabled').notNull().default(true),
  draftGraph: jsonb('draft_graph').$type<PlaybookGraph>().notNull().default({
    entryNodeId: 'start',
    nodes: [{ id: 'start', type: 'trigger', data: {} }],
    edges: [],
  }),
  activeVersion: integer('active_version'),
  templateKey: varchar('template_key', { length: 120 }),
  templateVersion: integer('template_version'),
  templateMode: varchar('template_mode', { length: 20 }).notNull().default('custom'),
  createdBy: integer('created_by').references(() => usersTable.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  userAgentNameUq: unique().on(table.businessProfileId, table.userId, table.agentType, table.name),
  userStatusIdx: index('idx_support_playbooks_user_status').on(table.userId, table.status),
  userAgentStatusIdx: index('idx_support_playbooks_user_agent_status').on(table.userId, table.agentType, table.status),
  userTemplateUq: uniqueIndex('support_playbooks_user_template_uq').on(table.businessProfileId, table.userId, table.templateKey),
}));

export const supportPlaybookVersionsTable = pgTable('support_playbook_versions', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  playbookId: integer('playbook_id').notNull().references(() => supportPlaybooksTable.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  graph: jsonb('graph').$type<PlaybookGraph>().notNull(),
  checksum: varchar('checksum', { length: 64 }).notNull(),
  publishedBy: integer('published_by').references(() => usersTable.id, { onDelete: 'set null' }),
  publishedAt: timestamp('published_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  playbookVersionUq: unique().on(table.playbookId, table.version),
}));

export const supportPlaybookAssignmentsTable = pgTable('support_playbook_assignments', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  playbookId: integer('playbook_id').notNull().references(() => supportPlaybooksTable.id, { onDelete: 'cascade' }),
  channel: varchar('channel', { length: 20 }),
  intent: varchar('intent', { length: 80 }),
  agentType: varchar('agent_type', { length: 50 }),
  priority: integer('priority').notNull().default(100),
  trafficPercent: integer('traffic_percent').notNull().default(100),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  matchIdx: index('idx_support_playbook_assignments_match')
    .on(table.userId, table.enabled, table.channel, table.intent, table.priority),
}));

export const supportPlaybookRunsTable = pgTable('support_playbook_runs', {
  businessProfileId: businessProfileColumn(),
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  conversationId: integer('conversation_id').notNull(),
  playbookId: integer('playbook_id').notNull().references(() => supportPlaybooksTable.id, { onDelete: 'cascade' }),
  playbookVersion: integer('playbook_version').notNull(),
  runSequence: integer('run_sequence').notNull().default(1),
  variant: varchar('variant', { length: 80 }),
  currentNodeId: varchar('current_node_id', { length: 120 }),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  state: jsonb('state').$type<Record<string, unknown>>().notNull().default({}),
  complianceScore: real('compliance_score'),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  runSequenceUq: unique().on(table.businessProfileId, table.userId, table.conversationId, table.playbookId, table.runSequence),
  activeConversationUq: uniqueIndex('support_playbook_runs_active_conversation_uq')
    .on(table.businessProfileId, table.userId, table.conversationId)
    .where(sql`${table.status} = 'active'`),
  conversationIdx: index('idx_support_playbook_runs_conversation').on(table.userId, table.conversationId, table.status),
}));

export interface DeliveryOutboxPayload {
  text: string;
  recipient: string;
  phoneNumberId?: string | null;
  replyToProviderMessageId?: string | null;
  subject?: string | null;
  choice?: SupportChoiceManifest;
  metadata?: Record<string, unknown>;
}

export const supportDeliveryOutboxTable = pgTable('support_delivery_outbox', {
  businessProfileId: businessProfileColumn(),
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  conversationId: integer('conversation_id').notNull(),
  channel: varchar('channel', { length: 20 }).notNull(),
  decisionKey: varchar('decision_key', { length: 255 }).notNull().unique(),
  inboundProviderMessageId: varchar('inbound_provider_message_id', { length: 255 }),
  playbookRunId: bigint('playbook_run_id', { mode: 'number' }).references(() => supportPlaybookRunsTable.id, { onDelete: 'set null' }),
  responseVersion: integer('response_version').notNull().default(1),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  payload: jsonb('payload').$type<DeliveryOutboxPayload>().notNull(),
  attemptCount: integer('attempt_count').notNull().default(0),
  providerMessageId: varchar('provider_message_id', { length: 255 }),
  lastError: text('last_error'),
  availableAt: timestamp('available_at').notNull().defaultNow(),
  nextAttemptAt: timestamp('next_attempt_at'),
  maxAttempts: integer('max_attempts').notNull().default(5),
  leaseExpiresAt: timestamp('lease_expires_at'),
  sendingAt: timestamp('sending_at'),
  sentAt: timestamp('sent_at'),
  reconciledBy: integer('reconciled_by').references(() => usersTable.id, { onDelete: 'set null' }),
  reconciledAt: timestamp('reconciled_at'),
  reconciliationNote: text('reconciliation_note'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  pendingIdx: index('idx_support_delivery_outbox_pending').on(table.status, table.availableAt),
  conversationIdx: index('idx_support_delivery_outbox_conversation').on(table.userId, table.conversationId),
}));

export const supportToolExecutionsTable = pgTable('support_tool_executions', {
  businessProfileId: businessProfileColumn(),
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  conversationId: integer('conversation_id').notNull(),
  insightsConversationKind: varchar('insights_conversation_kind', { length: 30 }),
  insightsConversationId: integer('insights_conversation_id'),
  toolName: varchar('tool_name', { length: 120 }).notNull(),
  idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull().unique(),
  riskLevel: varchar('risk_level', { length: 20 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('running'),
  args: jsonb('args').$type<Record<string, unknown>>().notNull().default({}),
  argumentDigest: varchar('argument_digest', { length: 96 }),
  approvalId: integer('approval_id').references(() => toolApprovalsTable.id, { onDelete: 'set null' }),
  result: jsonb('result'),
  error: text('error'),
  attemptCount: integer('attempt_count').notNull().default(1),
  lastAttemptAt: timestamp('last_attempt_at').notNull().defaultNow(),
  reconciledBy: integer('reconciled_by').references(() => usersTable.id, { onDelete: 'set null' }),
  reconciledAt: timestamp('reconciled_at'),
  reconciliationStatus: varchar('reconciliation_status', { length: 40 }),
  reconciliationNote: text('reconciliation_note'),
  startedAt: timestamp('started_at').notNull().defaultNow(),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  conversationIdx: index('idx_support_tool_executions_conversation').on(table.userId, table.conversationId, table.createdAt),
}));

export const supportEffectLedgerTable = pgTable('support_effect_ledger', {
  businessProfileId: businessProfileColumn(),
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  conversationId: integer('conversation_id').notNull(),
  effectKey: varchar('effect_key', { length: 255 }).notNull().unique(),
  effectType: varchar('effect_type', { length: 80 }).notNull(),
  status: varchar('status', { length: 32 }).notNull().default('running'),
  attemptCount: integer('attempt_count').notNull().default(1),
  startedAt: timestamp('started_at').notNull().defaultNow(),
  completedAt: timestamp('completed_at'),
  lastError: text('last_error'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  conversationIdx: index('idx_support_effect_ledger_conversation')
    .on(table.userId, table.conversationId, table.createdAt),
  statusIdx: index('idx_support_effect_ledger_status').on(table.status, table.updatedAt),
}));

export type SupportPrivacyVaultRecord = typeof supportPrivacyVaultTable.$inferSelect;
export type SupportPrivacyAccessLogRecord = typeof supportPrivacyAccessLogsTable.$inferSelect;
export type SupportPlaybookRecord = typeof supportPlaybooksTable.$inferSelect;
export type SupportPlaybookVersionRecord = typeof supportPlaybookVersionsTable.$inferSelect;
export type SupportPlaybookAssignmentRecord = typeof supportPlaybookAssignmentsTable.$inferSelect;
export type SupportPlaybookRunRecord = typeof supportPlaybookRunsTable.$inferSelect;
export type SupportDeliveryOutboxRecord = typeof supportDeliveryOutboxTable.$inferSelect;
export type SupportToolExecutionRecord = typeof supportToolExecutionsTable.$inferSelect;
export type SupportEffectLedgerRecord = typeof supportEffectLedgerTable.$inferSelect;

export const supportConversationTurnsTable = pgTable('support_conversation_turns', {
  businessProfileId: businessProfileColumn(),
  scopeKey: text('scope_key').primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  conversationId: integer('conversation_id').notNull(),
  channel: varchar('channel', { length: 20 }).notNull(),
  providerAccountId: text('provider_account_id').notNull().default(''),
  revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  consumedRevision: bigint('consumed_revision', { mode: 'number' }).notNull().default(0),
  leaseToken: uuid('lease_token'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => ({ recovery: index('idx_support_turn_recovery').on(table.updatedAt).where(sql`${table.revision}>${table.consumedRevision}`) }));

export const supportConversationTurnInputsTable = pgTable('support_conversation_turn_inputs', {
  businessProfileId: businessProfileColumn(),
  scopeKey: text('scope_key').notNull().references(() => supportConversationTurnsTable.scopeKey, { onDelete: 'cascade' }),
  sourceKey: text('source_key').notNull(),
  revision: bigint('revision', { mode: 'number' }).notNull(),
  messageId: bigint('message_id', { mode: 'number' }).notNull(),
  jobName: text('job_name').notNull(),
  payload: jsonb('payload').notNull(),
  ready: boolean('ready').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => ({ source: primaryKey({ columns: [table.scopeKey, table.sourceKey] }), revision: unique().on(table.scopeKey, table.revision) }));

export const supportConversationTurnRunsTable = pgTable('support_conversation_turn_runs', {
  businessProfileId: businessProfileColumn(),
  id: uuid('id').primaryKey(),
  scopeKey: text('scope_key').notNull().references(() => supportConversationTurnsTable.scopeKey, { onDelete: 'cascade' }),
  firstRevision: bigint('first_revision', { mode: 'number' }).notNull(),
  lastRevision: bigint('last_revision', { mode: 'number' }).notNull(),
  messageIds: jsonb('message_ids').notNull(),
  playbookBaseline: jsonb('playbook_baseline').notNull().default([]),
  ownershipSnapshot: text('ownership_snapshot').notNull().default('{}'),
  status: varchar('status', { length: 24 }).notNull().default('processing'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => ({ revision: unique().on(table.scopeKey, table.firstRevision, table.lastRevision) }));
