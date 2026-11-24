import { businessProfileColumn } from "../businessProfileColumn.js";
/**
 * ZeroBounce Usage Tracking Schema
 * Tracks usage of ZeroBounce API for email validation
 */

import {
  pgTable,
  serial,
  integer,
  varchar,
  text,
  timestamp,
  jsonb,
  decimal,
} from "drizzle-orm/pg-core";
import { usersTable } from "../users/schema";

export const zerobounceUsagesTable = pgTable("zerobounce_usages", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
  
  // Operation type: 'single_validation', 'batch_validation', 'credit_check'
  operationType: varchar("operation_type", { length: 50 }).notNull(),
  
  // Validation metrics
  emailsValidated: integer("emails_validated").default(0),
  validEmails: integer("valid_emails").default(0),
  invalidEmails: integer("invalid_emails").default(0),
  catchAllEmails: integer("catch_all_emails").default(0),
  unknownEmails: integer("unknown_emails").default(0),
  
  // Credits used (ZeroBounce uses credit-based pricing)
  creditsUsed: integer("credits_used").default(0),
  
  // Cost tracking (in cents, calculated from credits)
  costCents: decimal("cost_cents", { precision: 20, scale: 8 }).default("0"),
  
  // Context info
  service: varchar("service", { length: 100 }), // e.g., 'email_validation', 'lead_enrichment'
  purpose: varchar("purpose", { length: 100 }), // e.g., 'outreach_validation', 'lead_import'
  
  // Batch info (for batch validations)
  batchId: varchar("batch_id", { length: 100 }),
  
  // Result
  status: varchar("status", { length: 20 }).default("success"), // 'success', 'error', 'partial'
  errorMessage: text("error_message"),
  
  // Additional metadata
  metadata: jsonb("metadata").default({}),
  
  // Timestamps
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type ZerobounceUsage = typeof zerobounceUsagesTable.$inferSelect;
export type NewZerobounceUsage = typeof zerobounceUsagesTable.$inferInsert;
