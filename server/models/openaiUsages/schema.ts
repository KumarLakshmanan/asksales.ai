import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, varchar, text, timestamp, jsonb, numeric } from "drizzle-orm/pg-core";

// OpenAI API Usage Tracking Schema
export const openaiUsagesTable = pgTable("openai_usages", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  
  // User context
  userId: integer("user_id").notNull(), // User who triggered the API call
  threadId: integer("thread_id"), // Associated chat thread (if applicable)
  workflowId: varchar("workflow_id", { length: 100 }), // Associated workflow (if applicable)
  
  // Request details
  model: varchar("model", { length: 100 }).notNull(), // e.g., "gpt-4o", "gpt-4o-mini"
  provider: varchar("provider", { length: 50 }).notNull().default("openai"), // 'openai' | 'openrouter'
  purpose: varchar("purpose", { length: 100 }).notNull(), // e.g., "icp_generation", "intent_detection", "content_creation", "fit_score_calculation"
  service: varchar("service", { length: 100 }).notNull(), // e.g., "ICPGenerationService", "MetaPromptEngine", "OrchestratorAgent"
  action: varchar("action", { length: 255 }), // Specific action description
  
  // Token usage
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  totalTokens: integer("total_tokens"),
  
  // Cost tracking (in USD, stored as cents for precision)
  estimatedCostCents: numeric("estimated_cost_cents", { precision: 20, scale: 8, mode: 'number' }),
  
  // Request/Response metadata
  requestSummary: text("request_summary"), // Brief summary of the request (not full prompt for privacy)
  responseSuccess: integer("response_success").notNull().default(1), // 1 = success, 0 = failure
  errorMessage: text("error_message"), // Error details if failed
  
  // Performance
  durationMs: integer("duration_ms"), // How long the API call took
  
  // Additional context
  metadata: jsonb("metadata").$type<{
    temperature?: number;
    maxTokens?: number;
    hasConversationHistory?: boolean;
    icpId?: number;
    [key: string]: unknown;
  }>(),
  
  // Timestamps
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Type exports
export type OpenAIUsage = typeof openaiUsagesTable.$inferSelect;
export type InsertOpenAIUsage = typeof openaiUsagesTable.$inferInsert;
