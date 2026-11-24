import { businessProfileColumn } from "../businessProfileColumn.js";
/**
 * Budget Plans Schema
 * Budget planning and allocation for performance marketing
 */

import { pgTable, serial, integer, varchar, text, timestamp, jsonb, decimal } from 'drizzle-orm/pg-core';

export const budgetPlansTable = pgTable('budget_plans', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  workflowId: integer('workflow_id'),
  
  // Plan details
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  
  // Budget
  totalBudget: decimal('total_budget', { precision: 12, scale: 2 }).notNull(),
  currency: varchar('currency', { length: 10 }).default('USD'),
  
  // Time period
  startDate: timestamp('start_date').notNull(),
  endDate: timestamp('end_date').notNull(),
  
  // Channel allocation
  channelAllocations: jsonb('channel_allocations').notNull(), // Budget per channel (meta, google, etc.)
  
  // Campaign objectives
  primaryObjective: varchar('primary_objective', { length: 100 }).notNull(), // leads, traffic, conversions, brand awareness
  kpis: jsonb('kpis'), // Target KPIs
  
  // Recommendations
  recommendedCampaigns: jsonb('recommended_campaigns'), // AI-generated campaign suggestions
  recommendedBudgetSplit: jsonb('recommended_budget_split'), // Recommended budget distribution
  
  // Tracking
  spentAmount: decimal('spent_amount', { precision: 12, scale: 2 }).default('0'),
  remainingBudget: decimal('remaining_budget', { precision: 12, scale: 2 }),
  
  // Status
  status: varchar('status', { length: 50 }).notNull().default('draft'), // draft, active, completed, exceeded
  
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type BudgetPlanRecord = typeof budgetPlansTable.$inferSelect;
export type InsertBudgetPlan = typeof budgetPlansTable.$inferInsert;
