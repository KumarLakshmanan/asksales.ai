import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, uuid, varchar, timestamp, jsonb, integer } from "drizzle-orm/pg-core";
import { usersTable } from "../users/schema";
import { randomUUID } from "crypto";

export const agentsTable = pgTable("agents", {
  businessProfileId: businessProfileColumn(),
  id: uuid("id").$defaultFn(() => randomUUID()).primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  agentType: varchar("agent_type", { length: 50 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  status: varchar("status", { length: 20 }).default("idle"),
  capabilities: jsonb("capabilities"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type Agent = typeof agentsTable.$inferSelect;
export type InsertAgent = typeof agentsTable.$inferInsert;
