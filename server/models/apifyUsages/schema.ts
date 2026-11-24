import { businessProfileColumn } from "../businessProfileColumn.js";
import { sql } from "drizzle-orm";
import { pgTable, serial, integer, varchar, text, timestamp, jsonb, decimal, uniqueIndex, numeric } from "drizzle-orm/pg-core";

// Apify API Usage Tracking Schema
export const apifyUsagesTable = pgTable("apify_usages", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  
  // User context
  userId: integer("user_id").notNull(), // User who triggered the API call
  threadId: integer("thread_id"), // Associated chat thread (if applicable)
  workflowId: varchar("workflow_id", { length: 100 }), // Associated workflow (if applicable)
  
  // Actor details
  actorId: varchar("actor_id", { length: 255 }).notNull(), // e.g., "apify/instagram-profile-scraper"
  actorName: varchar("actor_name", { length: 255 }), // Human-readable name
  runId: varchar("run_id", { length: 100 }), // Apify run ID
  datasetId: varchar("dataset_id", { length: 100 }), // Output dataset ID
  
  // Request details
  purpose: varchar("purpose", { length: 100 }).notNull(), // e.g., "lead_generation", "profile_scraping", "hashtag_search"
  service: varchar("service", { length: 100 }).notNull(), // e.g., "WorkflowExecutorService", "ApifyService"
  action: varchar("action", { length: 255 }), // Specific action description
  
  // Usage metrics
  computeUnits: decimal("compute_units", { precision: 10, scale: 4 }), // Apify compute units used
  dataTransferGb: decimal("data_transfer_gb", { precision: 10, scale: 6 }), // Data transfer in GB
  itemsScraped: integer("items_scraped"), // Number of items/results returned
  
  // Cost tracking (in USD, stored as cents for precision)
  estimatedCostCents: numeric("estimated_cost_cents", { precision: 20, scale: 8, mode: 'number' }),
  
  // Request/Response metadata
  inputSummary: text("input_summary"), // Brief summary of the input (sanitized)
  responseSuccess: integer("response_success").notNull().default(1), // 1 = success, 0 = failure
  errorMessage: text("error_message"), // Error details if failed
  
  // Performance
  durationMs: integer("duration_ms"), // How long the actor run took
  
  // Additional context
  metadata: jsonb("metadata").$type<{
    inputItems?: number;
    outputItems?: number;
    maxConcurrency?: number;
    memoryMbytes?: number;
    datasetItems?: number;
    [key: string]: unknown;
  }>(),
  
  // Timestamps
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  apifyRunUsageUq: uniqueIndex('apify_usages_user_run_action_uq')
    .on(table.businessProfileId, table.userId, table.runId, table.action)
    .where(sql`${table.runId} IS NOT NULL AND ${table.action} = 'run_actor'`),
}));

// Type exports
export type ApifyUsage = typeof apifyUsagesTable.$inferSelect;
export type InsertApifyUsage = typeof apifyUsagesTable.$inferInsert;
