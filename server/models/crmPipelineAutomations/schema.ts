import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, varchar, text, timestamp, boolean, jsonb, index } from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema';
import type { AutomationDefinition } from '../../../shared/crmAutomations.js';

export const crmPipelineAutomationsTable = pgTable('crm_pipeline_automations', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  triggerType: varchar('trigger_type', { length: 50 }).notNull(),
  triggerConfig: jsonb('trigger_config').$type<Record<string, unknown>>().default({}),
  action: varchar('action', { length: 50 }).notNull(),
  actionConfig: jsonb('action_config').$type<Record<string, unknown>>().default({}),
  isActive: boolean('is_active').default(true),
  priority: integer('priority').default(0),
  condition: jsonb('condition').$type<Record<string, unknown>>().default({}),
  definition: jsonb('definition').$type<AutomationDefinition>(),
  revision: integer('revision').notNull().default(1),
  deletedAt: timestamp('deleted_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  userIdIdx: index('idx_crm_pipeline_automations_user_id').on(table.userId),
  isActiveIdx: index('idx_crm_pipeline_automations_is_active').on(table.isActive),
}));
