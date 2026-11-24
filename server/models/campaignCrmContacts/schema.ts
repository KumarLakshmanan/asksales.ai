import { pgTable, serial, integer, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { businessProfileColumn } from '../businessProfileColumn.js';
import { usersTable } from '../users/schema.js';
import { chatThreadsTable } from '../chatThreads/schema.js';
import { crmContactsTable } from '../crmContacts/schema.js';

export const campaignCrmContactsTable = pgTable('campaign_crm_contacts', {
  id: serial('id').primaryKey(),
  businessProfileId: businessProfileColumn(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  contactId: integer('contact_id').notNull().references(() => crmContactsTable.id, { onDelete: 'cascade' }),
  threadId: integer('thread_id').notNull().references(() => chatThreadsTable.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, table => ({ contactThread: uniqueIndex('campaign_crm_contacts_contact_thread_key').on(table.contactId, table.threadId) }));
