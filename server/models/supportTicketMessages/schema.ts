import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, bigint, varchar, text, timestamp, boolean, jsonb, index } from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema';
import { supportTicketsTable } from '../supportTickets/schema';
import { teamMembersTable } from '../teamMembers/schema';

export const supportTicketMessagesTable = pgTable('support_ticket_messages', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  ticketId: integer('ticket_id').notNull().references(() => supportTicketsTable.id, { onDelete: 'cascade' }),
  userId: integer('user_id').references(() => usersTable.id, { onDelete: 'set null' }),
  actorUserId: integer('actor_user_id').references(() => usersTable.id, {onDelete:'set null'}),
  memberId: integer('member_id').references(() => teamMembersTable.id, { onDelete: 'set null' }),
  direction: varchar('direction', { length: 20 }).notNull().default('outbound'),
  content: text('content').notNull(),
  isInternal: boolean('is_internal').default(false),
  attachments: jsonb('attachments').$type<Array<{ fileId: number; name: string; url: string; type: string }>>().default([]),
  deliveryActionId: bigint('delivery_action_id', { mode: 'number' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  ticketIdIdx: index('idx_support_ticket_messages_ticket_id').on(table.ticketId),
  createdAtIdx: index('idx_support_ticket_messages_created_at').on(table.createdAt),
  memberCreatedAtIdx: index('idx_support_ticket_messages_member_created').on(table.memberId, table.createdAt),
}));
