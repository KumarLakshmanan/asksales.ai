import { businessProfileColumn } from "../businessProfileColumn.js";
 
import { pgTable, uuid, varchar, jsonb, integer, timestamp, text, boolean, serial, index, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "../users/schema";
import { chatThreadsTable } from "../chatThreads/schema";
import { companySettings } from "../companySettings/schema";
import { randomUUID } from "crypto";

// Optimized ICP Schema - Essential fields for Lead Generation, Ads, and Outreach

export const icpProfilesTable = pgTable("icp_profiles", {
  businessProfileId: businessProfileColumn(),
  // Identification & System Fields
  id: serial("id").primaryKey(),
  uuid: uuid("uuid").$defaultFn(() => randomUUID()).notNull().unique(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  businessId: integer("business_id").references(() => companySettings.id, { onDelete: "set null" }), // Link to business
  promptId: integer("prompt_id"), // Reference to chat message that created this ICP
  threadId: integer("thread_id").references(() => chatThreadsTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),

  // Campaign Information
  campaignName: varchar("campaign_name", { length: 255 }),
  campaignObjective: text("campaign_objective"),
  targetAudience: text("target_audience"), // REQUIRED - Who is the target
  summary: text("summary"), // AI-generated summary of the ICP

  // Company Information - Essential Fields
  industry: varchar("industry", { length: 255 }), // Primary vertical (SaaS, MarTech, AI, etc.)
  subIndustry: varchar("sub_industry", { length: 255 }), // Email Marketing SaaS, HR SaaS, etc.
  // Target Company Criteria (for ICP, not user's company - that's in company_settings via businessId)
  targetCompanySizeRange: varchar("target_company_size_range", { length: 100 }), // "1-10", "11-50", "51-200", "201-500", "500-1000", "1000+"
  targetRevenueRange: varchar("target_revenue_range", { length: 100 }), // Annual revenue bands: "$0-1M", "$1-10M", "$10-50M", "$50M+"
  targetBusinessModel: varchar("target_business_model", { length: 100 }), // B2B SaaS, B2C, Marketplace, Enterprise, etc.

  // Geographic Targeting (Consolidated)
  primaryRegions: jsonb("primary_regions").$type<string[]>(), // ["US-CA", "US-NY", "UK", "Canada", "Australia"]
  
  // Target Buyer Persona
  primaryJobTitles: jsonb("primary_job_titles").$type<string[]>(), // ["CMO", "VP Marketing", "Marketing Manager"]
  
  // Budget & Commercial Fit
  budgetRange: varchar("budget_range", { length: 100 }), // "$5K-$25K/month", "$25K-$100K/month", "$100K+/month"
  
  // Lead Source Strategy
  primaryChannels: jsonb("primary_channels").$type<string[]>(), // ["LinkedIn", "Google Search", "Industry Events", "Referrals"]

  // Fit Scoring
  fitScore: integer("fit_score"), // 1-100, used to determine readiness for agent assignment

  // User Intent & Agent Recommendation
  userIntent: varchar("user_intent", { length: 100 }), // content_creation, lead_generation, outreach, performance_marketing
  recommendedAgentScores: jsonb("recommended_agent_scores").$type<Record<string, number>>(), // { "content-studio": 90, "lead-generation": 20, ... }

  // Messaging Framework
  primaryValueProposition: text("primary_value_proposition"), // Main benefit for target audience
  primaryPainPoint: text("primary_pain_point"), // Key problem being solved
  
  // System & Status
  status: varchar("status", { length: 50 }).default("active"), // active/archived/deleted
  approved: boolean("approved").default(false),
  approvedBy: integer("approved_by"),
  approvedAt: timestamp("approved_at"),
  // Approval is valid only for the exact revision the client reviewed.
  revision: integer("revision").notNull().default(1),
  approvedRevision: integer("approved_revision"),
}, (table) => ({
  // Primary indexes
  uuidIdx: uniqueIndex("icp_profiles_uuid_idx").on(table.uuid),
  
  // User and prompt indexes
  userIdIdx: index("icp_profiles_user_id_idx").on(table.userId),
  businessIdIdx: index("icp_profiles_business_id_idx").on(table.businessId),
  promptIdIdx: index("icp_profiles_prompt_id_idx").on(table.promptId),
  threadIdIdx: index("icp_profiles_thread_id_idx").on(table.threadId),
  userPromptIdx: index("icp_profiles_user_prompt_idx").on(table.userId, table.promptId),
  
  // Status indexes
  statusIdx: index("icp_profiles_status_idx").on(table.status),
  approvedIdx: index("icp_profiles_approved_idx").on(table.approved),
  
  // Campaign indexes
  campaignNameIdx: index("icp_profiles_campaign_name_idx").on(table.campaignName),
  
  // Industry and company indexes for filtering
  industryIdx: index("icp_profiles_industry_idx").on(table.industry),
  companySizeIdx: index("icp_profiles_company_size_idx").on(table.targetCompanySizeRange),
  
  // Time-based indexes
  createdAtIdx: index("icp_profiles_created_at_idx").on(table.createdAt),
  fitScoreIdx: index("icp_profiles_fit_score_idx").on(table.fitScore),
}));

// Type exports for optimized ICP schema
export type IcpProfile = typeof icpProfilesTable.$inferSelect;
export type InsertIcpProfile = typeof icpProfilesTable.$inferInsert;
