import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, text, timestamp, boolean, varchar, jsonb, integer, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { usersTable } from "../users/schema.js";
import { adminsTable } from "../admins/schema.js";

export const supportAgentTemplatesTable = pgTable("support_agent_templates", {
  id: serial("id").primaryKey(),
  agentType: varchar("agent_type", { length: 50 }).notNull().unique(),
  displayName: varchar("display_name", { length: 120 }).notNull(),
  description: text("description"),
  systemPrompt: text("system_prompt").notNull(),
  toolsEnabled: jsonb("tools_enabled").$type<string[]>().notNull().default([]),
  escalationRules: jsonb("escalation_rules").notNull().default({}),
  channelScope: jsonb("channel_scope").$type<string[]>().notNull().default([]),
  priority: integer("priority").notNull().default(10),
  metadata: jsonb("metadata").notNull().default({}),
  version: integer("version").notNull().default(1),
  updatedByAdmin: integer("updated_by_admin").references(() => adminsTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const aiAgentConfigsTable = pgTable("ai_agent_configs", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  agentType: varchar("agent_type", { length: 50 }).notNull(),
  enabled: boolean("enabled").default(false).notNull(),
  displayName: varchar("display_name", { length: 120 }),
  description: text("description"),
  systemPrompt: text("system_prompt"),
  toolsEnabled: jsonb("tools_enabled").default([]),
  escalationRules: jsonb("escalation_rules").default({}),
  modelOverride: varchar("model_override", { length: 50 }),
  channelScope: jsonb("channel_scope").default([]),
  priority: integer("priority").default(10),
  metadata: jsonb("metadata").default({}),
  templateVersion: integer("template_version"),
  templateMode: varchar("template_mode", { length: 20 }).notNull().default("custom"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  unq: unique().on(t.businessProfileId, t.userId, t.agentType),
  oneEnabledPerOwner: uniqueIndex("ai_agent_configs_one_enabled_per_user")
    .on(t.businessProfileId, t.userId)
    .where(sql`${t.enabled} = true`),
}));

export const insertAiAgentConfigSchema = createInsertSchema(aiAgentConfigsTable);
export const selectAiAgentConfigSchema = createSelectSchema(aiAgentConfigsTable);

export type AiAgentConfigRecord = typeof aiAgentConfigsTable.$inferSelect;
export type InsertAiAgentConfig = typeof aiAgentConfigsTable.$inferInsert;
