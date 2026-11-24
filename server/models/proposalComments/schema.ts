import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, text, timestamp, boolean, jsonb, index } from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema';
import { proposalsTable } from '../proposals/schema';

export const proposalCommentsTable = pgTable('proposal_comments', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  proposalId: integer('proposal_id').notNull().references(() => proposalsTable.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  parentCommentId: integer('parent_comment_id'),
  content: text('content').notNull(),
  mentions: jsonb('mentions').$type<number[]>().default([]),
  attachments: jsonb('attachments').$type<Array<{ name: string; url: string; type: string }>>().default([]),
  isResolved: boolean('is_resolved').default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  proposalIdIdx: index('idx_proposal_comments_proposal_id').on(table.proposalId),
  userIdIdx: index('idx_proposal_comments_user_id').on(table.userId),
  parentIdIdx: index('idx_proposal_comments_parent_id').on(table.parentCommentId),
}));
