import { businessProfileColumn } from "../businessProfileColumn.js";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { pgTable, serial, integer, varchar, text, timestamp, jsonb, boolean, index } from 'drizzle-orm/pg-core';
import { chatThreadsTable } from '../chatThreads/schema.js';
import { usersTable } from '../users/schema';
import { crmContactsTable } from '../crmContacts/schema';
import { leadsTable } from '../leads/schema';
import { outreachConversationsTable } from '../outreachConversations/schema';
import { supportTeamsTable } from '../supportTeams/schema';
import { teamMembersTable } from '../teamMembers/schema';

export const supportTicketsTable = pgTable('support_tickets', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  chatThreadId: integer('chat_thread_id').references(() => chatThreadsTable.id, { onDelete: 'set null' }),
  contactId: integer('contact_id').references(() => crmContactsTable.id, { onDelete: 'set null' }),
  leadId: integer('lead_id').references(() => leadsTable.id, { onDelete: 'set null' }),
  outreachConversationId: integer('outreach_conversation_id').references(() => outreachConversationsTable.id, { onDelete: 'set null' }),
  teamId: integer('team_id').references(() => supportTeamsTable.id, { onDelete: 'set null' }),
  // Brand Toolkit snapshotted when the ticket opened (migration 591).
  brandToolkitId: integer('brand_toolkit_id'),
  ticketNumber: varchar('ticket_number', { length: 50 }).notNull().unique(),
  subject: varchar('subject', { length: 500 }).notNull(),
  description: text('description'),
  status: varchar('status', { length: 50 }).notNull().default('open'),
  priority: varchar('priority', { length: 20 }).notNull().default('medium'),
  category: varchar('category', { length: 50 }).default('support'),
  handoffKey: varchar('handoff_key', { length: 160 }),
  // SLA
  slaDeadline: timestamp('sla_deadline'),
  resolvedAt: timestamp('resolved_at'),
  closedAt: timestamp('closed_at'),
  responseTime: integer('response_time'),
  // Review
  reviewToken: varchar('review_token', { length: 128 }).unique(),
  reviewTokenExpiresAt: timestamp('review_token_expires_at'),
  reviewRequestSentAt: timestamp('review_request_sent_at'),
  reviewRequestDeliveryStatus: varchar('review_request_delivery_status', { length: 20 }),
  reviewRequestDeliveryError: text('review_request_delivery_error'),
  reviewRequestStartedAt: timestamp('review_request_started_at'),
  rating: integer('rating'),
  reviewComment: text('review_comment'),
  reviewSubmittedAt: timestamp('review_submitted_at'),
  // Assignment
  assignedTo: integer('assigned_to').references(() => usersTable.id, { onDelete: 'set null' }),
  assignedMemberId: integer('assigned_member_id').references(() => teamMembersTable.id, { onDelete: 'set null' }),
  // Tracking
  totalMessages: integer('total_messages').default(0),
  unreadCount: integer('unread_count').default(0),
  tags: jsonb('tags').$type<string[]>().default([]),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  version: integer('version').notNull().default(1),
  deletedAt: timestamp('deleted_at'),
  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  userIdIdx: index('idx_support_tickets_user_id').on(table.userId),
  statusIdx: index('idx_support_tickets_status').on(table.status),
  priorityIdx: index('idx_support_tickets_priority').on(table.priority),
  assignedToIdx: index('idx_support_tickets_assigned_to').on(table.assignedTo),
  assignedMemberIdx: index('idx_support_tickets_assigned_member').on(table.assignedMemberId),
  contactIdIdx: index('idx_support_tickets_contact_id').on(table.contactId),
  createdAtIdx: index('idx_support_tickets_created_at').on(table.createdAt),
  teamIdIdx: index('idx_support_tickets_team_id').on(table.teamId),
}));
