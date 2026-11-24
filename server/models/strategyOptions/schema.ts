import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, text, integer, boolean, timestamp, jsonb, serial, index, uuid } from "drizzle-orm/pg-core";
import { workflowSessionsTable } from "../workflowSessions/schema";

export const strategyOptionsTable = pgTable("strategy_options", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  workflowId: uuid("workflow_id").references(() => workflowSessionsTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description").notNull(),
  expectedOutcome: text("expected_outcome").notNull(),
  agents: jsonb("agents").notNull(),
  estimatedTime: text("estimated_time").notNull(),
  successRate: integer("success_rate"),
  expectedImpact: text("expected_impact"),
  benefits: jsonb("benefits"),
  recommended: boolean("recommended"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  recommendedIdx: index("strategy_options_recommended_idx").on(table.recommended),
}));

export type StrategyOptionRecord = typeof strategyOptionsTable.$inferSelect;
export type InsertStrategyOption = typeof strategyOptionsTable.$inferInsert;
