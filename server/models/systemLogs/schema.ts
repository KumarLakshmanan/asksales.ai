import { pgTable, serial, varchar, text, timestamp, jsonb } from "drizzle-orm/pg-core";

/**
 * System Logs Table
 * Stores application-level error, warning, and info messages for admin visibility.
 */
export const systemLogsTable = pgTable("system_logs", {
  id: serial("id").primaryKey(),

  // Log level: error | warn | info | debug
  level: varchar("level", { length: 20 }).notNull(),

  // Human-readable log message
  message: text("message").notNull(),

  // Source service or controller (e.g. "ContentStudioController", "LeadScoringService")
  source: varchar("source", { length: 255 }),

  // Optional error stack trace
  stack: text("stack"),

  // Arbitrary JSON context (userId, threadId, request info, etc.)
  context: jsonb("context"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});
