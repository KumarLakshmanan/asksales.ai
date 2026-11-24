import { businessProfileColumn } from "../businessProfileColumn.js";
import { bigint, index, integer, pgTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { usersTable } from '../users/schema';
import { teamMembersTable } from '../teamMembers/schema';

export const supportMemberPresenceSessionsTable = pgTable('support_member_presence_sessions', {
  businessProfileId: businessProfileColumn(),
  id: bigint('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  memberId: integer('member_id').notNull().references(() => teamMembersTable.id, { onDelete: 'cascade' }),
  sessionFingerprint: varchar('session_fingerprint', { length: 64 }).notNull(),
  startedAt: timestamp('started_at').notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at').notNull().defaultNow(),
  endedAt: timestamp('ended_at'),
  endReason: varchar('end_reason', { length: 32 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  memberLastSeenIdx: index('idx_support_presence_member_last_seen').on(table.userId, table.memberId, table.lastSeenAt),
  oneOpenSession: uniqueIndex('support_presence_one_open_session_uq')
    .on(table.businessProfileId, table.userId, table.memberId, table.sessionFingerprint)
    .where(sql`${table.endedAt} IS NULL`),
}));
