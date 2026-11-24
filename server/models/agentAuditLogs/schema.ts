import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, bigint, text, varchar, timestamp, real, jsonb, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { usersTable } from "../users/schema.js";

export const agentAuditLogsTable = pgTable("agent_audit_logs", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  conversationId: integer("conversation_id").notNull(),
  channel: varchar("channel", { length: 20 }).notNull(),
  
  // Classification
  intent: varchar("intent", { length: 50 }),
  riskLevel: varchar("risk_level", { length: 15 }),
  classificationConfidence: real("classification_confidence"),
  
  // Agent execution
  agentType: varchar("agent_type", { length: 50 }),
  toolsCalled: jsonb("tools_called").default([]),      // [{name, args, result, durationMs}]
  kbSourcesUsed: jsonb("kb_sources_used").default([]), // [docId/title]
  llmModel: varchar("llm_model", { length: 50 }),
  providerName: varchar("provider_name", { length: 50 }),
  providerModel: varchar("provider_model", { length: 120 }),
  llmTokensUsed: integer("llm_tokens_used"),
  
  // Output
  replyText: text("reply_text"),
  confidence: real("confidence"),
  
  // Guardrails & Policies
  guardrailPassed: boolean("guardrail_passed"),
  guardrailViolations: jsonb("guardrail_violations").default([]),
  policyViolations: jsonb("policy_violations").default([]),
  playbookId: integer("playbook_id"),
  playbookVersion: integer("playbook_version"),
  playbookNodeId: varchar("playbook_node_id", { length: 120 }),
  piiTypes: jsonb("pii_types").default([]),
  deliveryActionId: bigint("delivery_action_id", { mode: "number" }),
  deliveryStatus: varchar("delivery_status", { length: 40 }),
  deliveryDeferred: boolean("delivery_deferred").notNull().default(false),
  providerMessageId: varchar("provider_message_id", { length: 255 }),
  trace: jsonb("trace").default({}),
  
  // Outcome
  outcome: varchar("outcome", { length: 30 }).notNull(), // 'auto_sent' | 'pending_approval' | 'human_handoff' | 'blocked' | 'error'
  decisionStatus: varchar('decision_status', { length: 30 }).notNull().default('finalized'),
  finalizedAt: timestamp('finalized_at'),
  durationMs: integer("duration_ms"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertAgentAuditLogSchema = createInsertSchema(agentAuditLogsTable);
export const selectAgentAuditLogSchema = createSelectSchema(agentAuditLogsTable);

export type AgentAuditLogRecord = typeof agentAuditLogsTable.$inferSelect;
export type InsertAgentAuditLog = typeof agentAuditLogsTable.$inferInsert;
