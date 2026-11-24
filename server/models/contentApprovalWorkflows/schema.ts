import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, uuid, integer, varchar, text, boolean, timestamp, jsonb, bigint } from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema';
import { contentAssetsTable } from '../contentAssets/schema';

/**
 * Historical-only schema for the retired standalone Content Creator approval
 * workflow. Keep these definitions available for audit/data-retention work,
 * but do not register or import them from application runtime code.
 */
export const contentApprovalWorkflowsTable = pgTable('content_approval_workflows', {
  businessProfileId: businessProfileColumn(),
  id: uuid('id').defaultRandom().primaryKey(), ownerUserId: integer('owner_user_id').notNull().references(() => usersTable.id),
  name: varchar('name', { length: 160 }).notNull(), description: text('description'), isActive: boolean('is_active').notNull().default(true),
  createdBy: integer('created_by').references(() => usersTable.id), createdAt: timestamp('created_at').notNull(), updatedAt: timestamp('updated_at').notNull(),
});
export const contentApprovalStagesTable = pgTable('content_approval_stages', {
  businessProfileId: businessProfileColumn(),
  id: uuid('id').defaultRandom().primaryKey(), workflowId: uuid('workflow_id').notNull().references(() => contentApprovalWorkflowsTable.id),
  position: integer('position').notNull(), name: varchar('name', { length: 160 }).notNull(), required: boolean('required').notNull().default(true), reminderAfterHours: integer('reminder_after_hours'), createdAt: timestamp('created_at').notNull(),
});
export const contentApprovalStageApproversTable = pgTable('content_approval_stage_approvers', {
  businessProfileId: businessProfileColumn(),
  id: uuid('id').defaultRandom().primaryKey(), stageId: uuid('stage_id').notNull().references(() => contentApprovalStagesTable.id),
  userId: integer('user_id').references(() => usersTable.id), role: varchar('role', { length: 50 }), displayName: varchar('display_name', { length: 160 }),
});
export const contentApprovalRequestsTable = pgTable('content_approval_requests', {
  businessProfileId: businessProfileColumn(),
  id: uuid('id').defaultRandom().primaryKey(), ownerUserId: integer('owner_user_id').notNull().references(() => usersTable.id),
  workflowId: uuid('workflow_id').notNull().references(() => contentApprovalWorkflowsTable.id), assetId: integer('asset_id').notNull().references(() => contentAssetsTable.id), assetVersion: integer('asset_version').notNull(),
  status: varchar('status', { length: 24 }).notNull().default('pending'), currentStagePosition: integer('current_stage_position').notNull().default(1), submittedBy: integer('submitted_by').references(() => usersTable.id),
  submittedAt: timestamp('submitted_at').notNull(), decidedAt: timestamp('decided_at'), reminderSentAt: timestamp('reminder_sent_at'), createdAt: timestamp('created_at').notNull(), updatedAt: timestamp('updated_at').notNull(),
});
export const contentApprovalDecisionsTable = pgTable('content_approval_decisions', {
  businessProfileId: businessProfileColumn(),
  id: uuid('id').defaultRandom().primaryKey(), requestId: uuid('request_id').notNull().references(() => contentApprovalRequestsTable.id), stageId: uuid('stage_id').notNull().references(() => contentApprovalStagesTable.id),
  actorUserId: integer('actor_user_id').notNull().references(() => usersTable.id), decision: varchar('decision', { length: 16 }).notNull(), comment: text('comment'), rejectionReason: text('rejection_reason'), createdAt: timestamp('created_at').notNull(),
});
export const contentApprovalAuditEventsTable = pgTable('content_approval_audit_events', {
  businessProfileId: businessProfileColumn(),
  id: bigint('id', { mode: 'number' }).primaryKey(), requestId: uuid('request_id').notNull().references(() => contentApprovalRequestsTable.id), ownerUserId: integer('owner_user_id').notNull().references(() => usersTable.id), actorUserId: integer('actor_user_id').references(() => usersTable.id), eventType: varchar('event_type', { length: 64 }).notNull(), eventData: jsonb('event_data').notNull(), createdAt: timestamp('created_at').notNull(),
});
