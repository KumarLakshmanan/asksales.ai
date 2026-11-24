import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, text, timestamp, boolean, jsonb, integer, unique } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { usersTable } from "../users/schema.js";

export const subAgentConfigsTable = pgTable("sub_agent_configs", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  mainAgentType: text("main_agent_type").notNull(),
  subAgentId: text("sub_agent_id").notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  config: jsonb("config").default({}),
  modelOverride: text("model_override"),
  priority: integer("priority").default(50),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  unq: unique().on(t.businessProfileId, t.userId, t.mainAgentType, t.subAgentId),
}));

export const insertSubAgentConfigSchema = createInsertSchema(subAgentConfigsTable);
export const selectSubAgentConfigSchema = createSelectSchema(subAgentConfigsTable);

export type SubAgentConfigRecord = typeof subAgentConfigsTable.$inferSelect;
export type InsertSubAgentConfig = typeof subAgentConfigsTable.$inferInsert;
