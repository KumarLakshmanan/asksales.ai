import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, text, varchar, timestamp, real, jsonb, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { usersTable } from "../users/schema.js";
import { supportTicketsTable } from "../supportTickets/schema.js";
import { supportTeamsTable } from "../supportTeams/schema.js";
import { teamMembersTable } from "../teamMembers/schema.js";

export const handoffQueueTable = pgTable("handoff_queue", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  conversationId: integer("conversation_id").notNull(),
  channel: varchar("channel", { length: 20 }).notNull(),
  status: varchar("status", { length: 30 }).default("waiting").notNull(), // 'waiting' | 'assigned' | 'in_progress' | 'resolved' | 'expired'
  priority: varchar("priority", { length: 15 }).default("medium").notNull(), // 'low' | 'medium' | 'high' | 'urgent'
  reason: text("reason"),
  triggerType: varchar("trigger_type", { length: 30 }), // 'low_confidence' | 'policy_violation' | 'risk_critical' | 'user_requested' | 'negative_sentiment'
  assignedTo: integer("assigned_to"),
  assignedMemberId: integer("assigned_member_id").references(() => teamMembersTable.id, { onDelete: "set null" }),
  supportTicketId: integer("support_ticket_id").references(() => supportTicketsTable.id, { onDelete: "set null" }),
  teamId: integer("team_id").references(() => supportTeamsTable.id, { onDelete: "set null" }),
  aiDraftReply: text("ai_draft_reply"),
  conversationContext: jsonb("conversation_context").default({}),
  confidenceScore: real("confidence_score"),
  slaDeadline: timestamp("sla_deadline"),
  acceptedAt: timestamp("accepted_at"),
  lastCustomerMessageAt: timestamp("last_customer_message_at"),
  aiReplyEnabled: boolean("ai_reply_enabled").default(true).notNull(),
  aiPausedAt: timestamp("ai_paused_at"),
  aiPausedBy: integer("ai_paused_by").references(() => teamMembersTable.id, { onDelete: "set null" }),
  version: integer("version").default(1).notNull(),
  resolution: varchar("resolution", { length: 40 }),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertHandoffQueueSchema = createInsertSchema(handoffQueueTable);
export const selectHandoffQueueSchema = createSelectSchema(handoffQueueTable);

export type HandoffQueueRecord = typeof handoffQueueTable.$inferSelect;
export type InsertHandoffQueue = typeof handoffQueueTable.$inferInsert;
